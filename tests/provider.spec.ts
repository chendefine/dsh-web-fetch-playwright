/**
 * The provider over a fake browser session: URL hygiene, content-type
 * branching, the denoise toggle, body caps, and error taxonomy — plus one
 * real-socket case for the CDP connect failure path.
 */
import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import type { ResolvedConfig } from '../src/config.ts'
import { PlaywrightFetchProvider } from '../src/provider.ts'
import type { BrowserSession } from '../src/provider.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage, PlaywrightResponse } from '../src/types.ts'

/** Everything a fake navigation can be told to produce. */
interface FakePageSpec {
  finalUrl?: string
  status?: number
  contentType?: string
  html?: string
  textBody?: string
  gotoError?: Error
  networkIdleError?: boolean
}

const ARTICLE_HTML = `<!doctype html><html><head><title>Fake page</title></head><body>
<nav>nav noise</nav>
<main><article><h1>Hello</h1><p>World</p><p>A second paragraph gives the article scorer enough text mass to find the main region.</p></article></main>
<footer>footer noise</footer>
</body></html>`

function fakeResponse(spec: FakePageSpec): PlaywrightResponse | null {
  if (spec.gotoError !== undefined) return null
  return {
    status: () => spec.status ?? 200,
    headers: () => ({ 'content-type': spec.contentType ?? 'text/html; charset=utf-8' }),
    text: async () => spec.textBody ?? '',
  }
}

function fakeSession(spec: FakePageSpec): BrowserSession {
  const closed = { context: false, browser: false }
  const page: PlaywrightPage = {
    goto: async () => {
      if (spec.gotoError !== undefined) throw spec.gotoError
      return fakeResponse(spec)
    },
    waitForLoadState: async () => {
      if (spec.networkIdleError === true) throw new Error('networkidle timeout')
    },
    url: () => spec.finalUrl ?? 'https://final.example.com/docs',
    content: async () => spec.html ?? ARTICLE_HTML,
    close: async () => {},
  }
  const context: PlaywrightContext = {
    newPage: async () => page,
    route: async () => {},
    close: async () => { closed.context = true },
  }
  const browser: PlaywrightBrowser = {
    newContext: async () => context,
    close: async () => { closed.browser = true },
  }
  return { browser, context, closed } as unknown as BrowserSession & typeof closed
}

/** The provider under test: a fixed config and an injected fake session. */
class FakeProvider extends PlaywrightFetchProvider {
  constructor(config: Partial<ResolvedConfig> = {}, private readonly spec: FakePageSpec = {}) {
    super(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
      ...config,
    }))
  }

  protected async openSession(): Promise<BrowserSession> {
    return fakeSession(this.spec)
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const webError = error as WebError
    if (webError instanceof WebError) return webError.code
    throw error
  }
  throw new Error('expected the fetch to reject')
}

describe('PlaywrightFetchProvider', () => {
  it('is always available (cheap check, no side effects)', () => {
    expect(new FakeProvider().available()).toBe(true)
    expect(new FakeProvider().id).toBe('playwright')
  })

  it('rejects non-http schemes and credentialed URLs up front', async () => {
    await expect(codeOf(new FakeProvider().fetch({ url: 'ftp://example.com/x' }))).resolves.toBe('WEB_INVALID_URL')
    await expect(codeOf(new FakeProvider().fetch({ url: 'http://user:pass@example.com/' }))).resolves.toBe('WEB_BLOCKED_URL')
    await expect(codeOf(new FakeProvider().fetch({ url: 'not a url' }))).resolves.toBe('WEB_INVALID_URL')
  })

  it('returns denoised markdown for html pages', async () => {
    const result = await new FakeProvider().fetch({ url: 'https://example.com/docs' })
    expect(result.url).toBe('https://final.example.com/docs')
    expect(result.statusCode).toBe(200)
    expect(result.truncated).toBe(false)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    // Either the kept article heading or the prepended page title leads it.
    expect(content).toMatch(/^# (Hello|Fake page)\b/m)
    expect(content).toContain('World')
    expect(content).not.toContain('nav noise')
    expect(content).not.toContain('footer noise')
  })

  it('returns raw html when the denoise toggle is off', async () => {
    const result = await new FakeProvider({ denoise: false }).fetch({ url: 'https://example.com/docs' })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') {
      expect(result.body.content).toContain('<article>')
      expect(result.body.content).toContain('nav noise')
    }
  })

  it('decodes non-html text bodies verbatim', async () => {
    const result = await new FakeProvider({}, { contentType: 'application/json', textBody: '{"ok":true}' })
      .fetch({ url: 'https://example.com/api' })
    expect(result.body).toEqual({ kind: 'text', content: '{"ok":true}' })
  })

  it('refuses binary content types', async () => {
    const code = await codeOf(new FakeProvider({}, { contentType: 'image/png' }).fetch({ url: 'https://example.com/img' }))
    expect(code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')
  })

  it('keeps a non-2xx status as a result, not an error', async () => {
    const result = await new FakeProvider({}, { status: 404, html: '<html><body><h1>Not found</h1></body></html>' })
      .fetch({ url: 'https://example.com/missing' })
    expect(result.statusCode).toBe(404)
  })

  it('caps the body and flags the cut', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `<p>paragraph ${String(i)} with some words</p>`).join('')
    const html = `<!doctype html><html><body><article><h1>Big</h1>${big}</article></body></html>`
    const result = await new FakeProvider({}, { html }).fetch({ url: 'https://example.com/big' })
    expect(result.truncated).toBe(true)
    expect((result.body as { content: string }).content.length).toBe(100_000)
  })

  it('maps navigation failures to WEB_PROVIDER_ERROR with the original message', async () => {
    const code = await codeOf(
      new FakeProvider({}, { gotoError: new Error('net::ERR_CONNECTION_REFUSED at https://example.com') })
        .fetch({ url: 'https://example.com/down' }),
    )
    expect(code).toBe('WEB_PROVIDER_ERROR')
  })

  it('translates a pre-aborted signal to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const code = await codeOf(new FakeProvider().fetch({ url: 'https://example.com/x' }, controller.signal))
    expect(code).toBe('WEB_ABORTED')
  })

  it('survives a networkidle settle timeout (keeps domcontentloaded content)', async () => {
    const result = await new FakeProvider({}, { networkIdleError: true }).fetch({ url: 'https://example.com/spa' })
    expect(result.body.kind).toBe('text')
  })

  it('reports a dead CDP endpoint as WEB_PROVIDER_ERROR naming the endpoint', { timeout: 30_000 }, async () => {
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '127.0.0.1:1',
      denoise: true,
    }))
    // Real bundled playwright-core; port 1 refuses connections immediately.
    const error = await provider.fetch({ url: 'https://example.com/x' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((error as WebError).message).toContain('127.0.0.1:1')
  })
})
