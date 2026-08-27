/**
 * Challenge detection, pure-function coverage: the response-level verdicts
 * (cf-mitigated header, the 403/503 + cloudflare fallback), the content-level
 * verdicts (localized title family, structural markers, the hard-block page),
 * false-positive guards (pages that merely mention Cloudflare), and a
 * DOM-double execution check of the in-page probe.
 */
import { describe, expect, it } from 'vitest'
import {
  CHALLENGE_DOM_PROBE,
  CHALLENGE_FINISH_RESERVE_MS,
  CHALLENGE_POLL_INTERVAL_MS,
  CHALLENGE_TITLE_RE,
  classifyChallengeHtml,
  classifyChallengeResponse,
  isChallengeCompatibleResponse,
} from '../src/challenge.ts'

/** A typical managed-challenge interstitial (English). */
const CHALLENGE_HTML = `<!doctype html><html lang="en"><head><title>Just a moment...</title></head>
<body><div class="main-wrapper"><div class="main-content">
<h2 class="h2">Checking your browser before accessing example.com.</h2>
<div id="challenge-stage"><div id="challenge-running"><span class="spinner"></span>Verifying you are human.</div></div>
<noscript>Enable JavaScript and cookies to continue</noscript>
<div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: 8f2a1b2c3d4e5f6a</span></div></div>
</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/abc" async></script>
<script>window._cf_chl_opt = { cvId: 3 };</script>
</body></html>`

/** A normal article that talks ABOUT Cloudflare but is not a challenge. */
const ARTICLE_ABOUT_CLOUDFLARE = `<!doctype html><html><head><title>How Cloudflare protects sites</title></head><body>
<main><article><h1>How Cloudflare protects sites</h1>
<p>We discuss the Turnstile widget and how cf-mitigated responses work, and even show
a snippet like <code>cf-chl-widget-abc123</code> inside prose, because a real article
may quote these strings.</p></article></main></body></html>`

describe('classifyChallengeResponse', () => {
  it('the documented header alone marks a challenge, whatever the status', () => {
    expect(classifyChallengeResponse(403, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' })).toBe('challenge')
    expect(classifyChallengeResponse(503, { 'cf-mitigated': 'challenge', 'content-type': 'text/html; charset=utf-8' })).toBe('challenge')
    // Turnstile interstitials and managed challenges arrive with either status.
    expect(classifyChallengeResponse(200, { 'cf-mitigated': 'challenge', 'content-type': 'text/html' })).toBe('challenge')
  })

  it('matches the header case-insensitively and tolerates whitespace', () => {
    expect(classifyChallengeResponse(403, { 'cf-mitigated': 'Challenge', 'content-type': 'text/html' })).toBe('challenge')
    expect(classifyChallengeResponse(403, { 'cf-mitigated': '  CHALLENGE  ', 'content-type': 'text/html' })).toBe('challenge')
  })

  it('other cf-mitigated values are not challenges', () => {
    expect(classifyChallengeResponse(200, { 'cf-mitigated': 'high', 'content-type': 'text/html' })).toBe('none')
    expect(classifyChallengeResponse(200, { 'content-type': 'text/html' })).toBe('none')
  })

  it('falls back to 403/503 + cloudflare server + html content type', () => {
    expect(classifyChallengeResponse(403, { server: 'cloudflare', 'content-type': 'text/html' })).toBe('challenge')
    expect(classifyChallengeResponse(503, { server: 'cloudflare' })).toBe('challenge') // blank mime reads as html
    expect(classifyChallengeResponse(403, { server: 'cloudflare', 'content-type': 'application/json' })).toBe('none')
    expect(classifyChallengeResponse(403, { server: 'nginx', 'content-type': 'text/html' })).toBe('none')
    expect(classifyChallengeResponse(200, { server: 'cloudflare', 'content-type': 'text/html' })).toBe('none')
  })
})

describe('isChallengeCompatibleResponse (the suspicion gate)', () => {
  it('interstitial statuses open the gate whatever the server', () => {
    expect(isChallengeCompatibleResponse(403, { server: 'nginx' })).toBe(true)
    expect(isChallengeCompatibleResponse(429, {})).toBe(true)
    expect(isChallengeCompatibleResponse(503, {})).toBe(true)
  })

  it('a Cloudflare edge opens the gate even on a 200', () => {
    expect(isChallengeCompatibleResponse(200, { server: 'cloudflare' })).toBe(true)
    expect(isChallengeCompatibleResponse(200, { 'cf-ray': '8f2aabc123-lax' })).toBe(true)
  })

  it('a plain 200 from a non-Cloudflare origin never reaches the content checks', () => {
    expect(isChallengeCompatibleResponse(200, { server: 'nginx' })).toBe(false)
    expect(isChallengeCompatibleResponse(200, { server: 'apache', 'content-type': 'text/html' })).toBe(false)
    expect(isChallengeCompatibleResponse(301, { server: 'nginx' })).toBe(false)
    expect(isChallengeCompatibleResponse(500, { server: 'nginx' })).toBe(false)
  })
})

describe('classifyChallengeHtml', () => {
  it('classifies the canonical interstitial through every marker family', () => {
    expect(classifyChallengeHtml(CHALLENGE_HTML)).toBe('challenge')
    // Each structural marker alone is enough (title stripped, one marker left).
    expect(classifyChallengeHtml('<html><head><title>x</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/x"></script></body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><body><div id="challenge-form"></div></body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><body><div id="challenge-running"></div></body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><body><iframe id="cf-chl-widget-0001" src="https://challenges.cloudflare.com"></iframe></body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><body><script>window._cf_chl_opt={}</script></body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><head><title>Just a moment...</title></head><body></body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><body>Checking your browser before accessing example.com.</body></html>')).toBe('challenge')
    expect(classifyChallengeHtml('<html><body><div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: x</span></div></div></body></html>')).toBe('challenge')
  })

  it('recognizes the localized title family', () => {
    for (const title of [
      'Just a moment...', // en
      'Just a moment…', // en, single-glyph ellipsis
      '请稍候…', // zh-CN
      '請稍候…', // zh-TW
      '少し時間がかかります…', // ja
      'Einen Moment...', // de
      'Un instant...', // fr
      'Un momento...', // es / it
      'Um momento...', // pt
      'Минутку...', // ru
      '잠시만요...', // ko
      'Een ogenblik geduld...', // nl
      'Bir dakika...', // tr
    ]) {
      expect(classifyChallengeHtml(`<!doctype html><html><head><title>${title}</title></head><body></body></html>`), `title "${title}" should classify as challenge`).toBe('challenge')
    }
  })

  it('titles that merely start like the family do not match (anchored)', () => {
    expect(CHALLENGE_TITLE_RE.test('A moment of science')).toBe(false)
    expect(CHALLENGE_TITLE_RE.test('Just a moment of silence, please — reflections')).toBe(false)
    expect(classifyChallengeHtml('<!doctype html><html><head><title>A moment of science</title></head><body><p>article</p></body></html>')).toBe('none')
  })

  it('a normal article that talks about Cloudflare is not a challenge', () => {
    expect(classifyChallengeHtml(ARTICLE_ABOUT_CLOUDFLARE)).toBe('none')
  })

  it('recognizes the hard-block page distinctly', () => {
    expect(classifyChallengeHtml('<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1></body></html>')).toBe('blocked')
    expect(classifyChallengeHtml('<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>')).toBe('blocked')
    // The body phrase gated by a structural block-page marker also classifies.
    expect(classifyChallengeHtml('<html><head><title>Blocked</title></head><body><h1 class="cf-headline">Sorry, you have been blocked</h1></body></html>')).toBe('blocked')
    expect(classifyChallengeHtml('<html><body><div class="cf-error-details"><h1>you have been blocked</h1></div></body></html>')).toBe('blocked')
  })

  it('an article that merely contains the blocked phrase in prose is not a hard block', () => {
    expect(classifyChallengeHtml('<!doctype html><html><head><title>What to do when you have been blocked by a firewall</title></head><body><main><article><h1>When you have been blocked</h1><p>So you have been blocked by your proxy — here is how to tell.</p></article></main></body></html>')).toBe('none')
  })

  it('empty html is none', () => {
    expect(classifyChallengeHtml('')).toBe('none')
  })
})

describe('CHALLENGE_DOM_PROBE', () => {
  /** Minimal document double the probe's compiled IIFE can run against. */
  function fakeDocument(input: { title?: string; selectors?: Record<string, boolean>; scriptSrcs?: string[] }): {
    title: string
    querySelector(selector: string): object | null
    scripts: Array<{ getAttribute(name: string): string | null }>
  } {
    return {
      title: input.title ?? '',
      querySelector: (selector: string) => (input.selectors?.[selector] === true ? {} : null),
      scripts: (input.scriptSrcs ?? []).map(src => ({ getAttribute: (name: string) => (name === 'src' ? src : null) })),
    }
  }

  /** Compile the probe and run it against a document double. */
  function runProbe(document: unknown): boolean {
    const fn = new Function('document', `return (${CHALLENGE_DOM_PROBE})`)
    return (fn(document) as boolean)
  }

  it('compiles as a standalone expression', () => {
    expect(() => { new Function('document', `return (${CHALLENGE_DOM_PROBE})`) }).not.toThrow()
    expect(CHALLENGE_DOM_PROBE).toContain('challenge-form')
  })

  it('reports true while interstitial markers are live in the DOM', () => {
    expect(runProbe(fakeDocument({ title: 'Just a moment...' }))).toBe(true)
    expect(runProbe(fakeDocument({ title: '请稍候…' }))).toBe(true)
    expect(runProbe(fakeDocument({ selectors: { '#challenge-form, #challenge-running, #challenge-stage, #challenge-error-text': true } }))).toBe(true)
    expect(runProbe(fakeDocument({ selectors: { '[id^="cf-chl-widget-"]': true } }))).toBe(true)
    expect(runProbe(fakeDocument({ scriptSrcs: ['/cdn-cgi/challenge-platform/h/b/x'] }))).toBe(true)
    expect(runProbe(fakeDocument({ selectors: { '.footer .footer-inner .ray-id': true } }))).toBe(true)
  })

  it('reports false once the real document replaced the challenge (SPA clear)', () => {
    expect(runProbe(fakeDocument({ title: 'Real protected article' }))).toBe(false)
    expect(runProbe(fakeDocument({ title: 'Real protected article', scriptSrcs: ['/static/app.js'] }))).toBe(false)
  })

  it('exports sane bounded-wait constants', () => {
    expect(CHALLENGE_POLL_INTERVAL_MS).toBeGreaterThan(0)
    // The reserve must cover the 5s networkidle settle plus pipeline headroom.
    expect(CHALLENGE_FINISH_RESERVE_MS).toBeGreaterThanOrEqual(5_000 + 2_000)
  })
})
