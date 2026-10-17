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

/**
 * The passive JSD-iframe bootstrap Cloudflare Bot Management injects into
 * every NORMAL page of a protected zone — captured verbatim (minus noise)
 * from https://openrouter.ai/openai/gpt-6-astra-pro, a plain 200 of real
 * content. Its inline text strings the JSD telemetry URL, which embeds the
 * challenge-platform prefix; the regression (badcase: openrouter.ai) is that
 * the prefix scan misread this as an interstitial, the DOM probe then
 * correctly said "not challenged", and the chained-round recheck overrode it
 * with the same false positive until every attempt burned down.
 */
const JSD_BOOTSTRAP_PAGE = `<!doctype html><html><head><title>GPT-6 Astra Pro - API Pricing &amp; Providers | OpenRouter</title></head><body>
<main><article><h1>OpenAI: GPT-6 Astra Pro</h1><p>Real body text of a normal 200 page.</p></article></main>
<script>(function(){function c(){var b=a.contentDocument||(a.contentWindow&&a.contentWindow.document);if(b){var d=b.createElement('script');d.innerHTML="window.__CF$cv$params={r:'a36c81a84a7ad7cc',t:'MTc4ODY4NzU2Ng=='};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}if(document.body){var a=document.createElement('iframe');a.height=1;a.width=1;a.style.position='absolute';document.body.appendChild(a);c()}})()</script>
</body></html>`

/** The direct-injection variant some protected zones serve instead. */
const JSD_DIRECT_PAGE = `<!doctype html><html><head><title>A normal protected page</title>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js" defer></script>
</head><body><main><article><h1>Article</h1><p>Body.</p></article></main></body></html>`

/**
 * Cloudflare Precursor — the continuous behavioral-validation script
 * injected into NORMAL pages of a protected zone, captured from
 * https://www.nodeseek.com/post-523877-1 (HTTP 200, `server: cloudflare`,
 * no `cf-mitigated`, full article rendered). The regression is identical to
 * the JSD badcase: the challenge-platform prefix scan saw this one passive
 * script, the bounded wait could never confirm a clear, and two 15s attempts
 * turned a 4s page load into a `WEB_FETCH_CHALLENGE`.
 */
const PRECURSOR_PAGE = `<!doctype html><html><head><title>[腾讯云轻量被封]疑似端口转发给侦测</title>
<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js" defer></script>
</head><body><main><article><h1>[腾讯云轻量被封]疑似端口转发给侦测</h1><p>Real body text.</p></article></main></body></html>`

/**
 * A page that merely TALKS about the injected scripts — captured from
 * https://community.cloudflare.com/t/3-javascripts-are-added-unable-to-disable/848155
 * (HTTP 200, no `cf-mitigated`, no challenge-platform `<script src>` at all,
 * 4512 chars of real thread text). Its body lists
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` and the hashed
 * `/cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js` variant as
 * PROSE — the whole-document substring scan classified it as a challenge and
 * the fetch died without ever reading the thread.
 */
const ARTICLE_QUOTING_CF_PATHS = `<!doctype html><html><head><title>3 JavaScripts are added unable to disable</title></head><body>
<main><article><h1>3 JavaScripts are added unable to disable</h1>
<p>I am experiencing unexpected script injections on my site from Cloudflare's challenge platform, such as
/cdn-cgi/challenge-platform/scripts/jsd/main.js, /cdn-cgi/challenge-platform/h/g/scripts/jsd/e9c9e9d67513/main.js,
and /cdn-cgi/challenge-platform/scripts/precursor/main.js.</p>
<p>An escaped code sample is just prose too: &lt;script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"&gt;&lt;/script&gt;</p>
</article></main></body></html>`

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
    expect(classifyChallengeHtml('<html><head><title>x</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/x"></script></body></html>')).toBe('challenge')
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

  it('Bot Management passive JSD telemetry is not a challenge (openrouter.ai badcase)', () => {
    // The hidden-iframe bootstrap strings the JSD URL inside inline script
    // text on every normal page of a protected zone — a plain 200 with real
    // content must classify clean, or the bounded wait can never confirm a
    // clear and the fetch dies with WEB_FETCH_CHALLENGE (last status 200).
    expect(classifyChallengeHtml(JSD_BOOTSTRAP_PAGE)).toBe('none')
    // The direct-injection variant (the script tag itself in the head).
    expect(classifyChallengeHtml(JSD_DIRECT_PAGE)).toBe('none')
    // Query-string variants of the telemetry URL stay neutralized too.
    expect(classifyChallengeHtml('<html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=abc" defer></script></head><body><p>x</p></body></html>')).toBe('none')
  })

  it('Cloudflare Precursor instrumentation is not a challenge (nodeseek.com badcase)', () => {
    // Precursor is the behavioral-validation engine Cloudflare injects into
    // normal pages of a protected zone — same passive shape as JSD. Left
    // unstripped it burns the whole budget on a wait that can never clear.
    expect(classifyChallengeHtml(PRECURSOR_PAGE)).toBe('none')
    expect(classifyChallengeHtml('<html><head><script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js?v=2" defer></script></head><body><p>x</p></body></html>')).toBe('none')
    // Both passive scripts together still classify clean.
    expect(classifyChallengeHtml(`${JSD_DIRECT_PAGE}<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js" defer></script>`)).toBe('none')
  })

  it('stripping JSD telemetry does not over-exclude a real interstitial', () => {
    // A real challenge page may carry the JSD script AND its own orchestrate
    // scripts; the orchestrate path survives the strip and still classifies.
    expect(classifyChallengeHtml(`${CHALLENGE_HTML}<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js" defer></script>`)).toBe('challenge')
    // Same for Precursor: the boundary is "under scripts/", not one filename.
    expect(classifyChallengeHtml(`${CHALLENGE_HTML}<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js" defer></script>`)).toBe('challenge')
  })

  it('instrumentation on a hash-scoped mount is passive too', () => {
    // Cloudflare also serves detections from /h/[b|g]/ mounts: the hash-scoped
    // `/h/g/scripts/jsd/<hash>/main.js` AND `/h/g/jsd/r/…`, which has no
    // `scripts/` segment at all — the reason the runtime is matched
    // positively instead of carving out a namespace.
    expect(classifyChallengeHtml('<html><head><script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/e9c9e9d67513/main.js" defer></script></head><body><p>x</p></body></html>')).toBe('none')
    expect(classifyChallengeHtml('<html><head><script src="/cdn-cgi/challenge-platform/h/g/jsd/r/7f3"></script></head><body><p>x</p></body></html>')).toBe('none')
  })

  it('a page that merely QUOTES challenge-platform paths is not a challenge', () => {
    // Whole-document substring scanning can't tell a script tag from prose.
    // The community thread listing the injected URLs is the badcase.
    expect(classifyChallengeHtml(ARTICLE_QUOTING_CF_PATHS)).toBe('none')
    // A bare mention without any src attribute is not script evidence.
    expect(classifyChallengeHtml('<html><body><p>See /cdn-cgi/challenge-platform/ for details.</p></body></html>')).toBe('none')
  })

  it('script evidence reads real src attributes, in every quoting style', () => {
    // Double, single and bare quotes are all real elements.
    expect(classifyChallengeHtml(`<html><head><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/x"></script></head><body><p>x</p></body></html>`)).toBe('challenge')
    expect(classifyChallengeHtml(`<html><head><script src='/cdn-cgi/challenge-platform/h/b/orchestrate/x'></script></head><body><p>x</p></body></html>`)).toBe('challenge')
    expect(classifyChallengeHtml(`<html><head><script src=/cdn-cgi/challenge-platform/h/b/orchestrate/x></script></head><body><p>x</p></body></html>`)).toBe('challenge')
    // A challenge-platform script outside the runtime mount is instrumentation:
    // Cloudflare serves detections from hash-scoped mounts with no `scripts/`
    // segment at all — `/h/g/jsd/r/…` — so only the runtime path may count.
    expect(classifyChallengeHtml('<html><head><script src="/cdn-cgi/challenge-platform/h/g/jsd/r/7f3"></script></head><body><p>x</p></body></html>')).toBe('none')
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
    expect(runProbe(fakeDocument({ scriptSrcs: ['/cdn-cgi/challenge-platform/h/b/orchestrate/x'] }))).toBe(true)
    expect(runProbe(fakeDocument({ selectors: { '.footer .footer-inner .ray-id': true } }))).toBe(true)
  })

  it('reports false once the real document replaced the challenge (SPA clear)', () => {
    expect(runProbe(fakeDocument({ title: 'Real protected article' }))).toBe(false)
    expect(runProbe(fakeDocument({ title: 'Real protected article', scriptSrcs: ['/static/app.js'] }))).toBe(false)
    // JSD telemetry srcs are passive detection on normal pages, not markers.
    expect(runProbe(fakeDocument({ title: 'Real protected article', scriptSrcs: ['/cdn-cgi/challenge-platform/scripts/jsd/main.js', '/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=abc'] }))).toBe(false)
    // Precursor srcs are equally passive (the nodeseek.com badcase).
    expect(runProbe(fakeDocument({ title: 'Real protected article', scriptSrcs: ['/cdn-cgi/challenge-platform/scripts/precursor/main.js'] }))).toBe(false)
    // Hash-scoped instrumentation mounts are passive, `scripts/` segment or not.
    expect(runProbe(fakeDocument({ title: 'Real protected article', scriptSrcs: ['/cdn-cgi/challenge-platform/h/g/scripts/jsd/e9c9e9d67513/main.js'] }))).toBe(false)
    expect(runProbe(fakeDocument({ title: 'Real protected article', scriptSrcs: ['/cdn-cgi/challenge-platform/h/g/jsd/r/7f3'] }))).toBe(false)
  })

  it('script evidence mirrors the Node-side boundary', () => {
    // A runtime path outside the passive namespace still reports true...
    expect(runProbe(fakeDocument({ scriptSrcs: ['/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/x'] }))).toBe(true)
    // ...and src matching is case-insensitive, like classifyChallengeHtml.
    expect(runProbe(fakeDocument({ scriptSrcs: ['/CDN-CGI/Challenge-Platform/h/b/orchestrate/x'] }))).toBe(true)
  })

  it('exports sane bounded-wait constants', () => {
    expect(CHALLENGE_POLL_INTERVAL_MS).toBeGreaterThan(0)
    // The reserve must cover the 5s networkidle settle plus pipeline headroom.
    expect(CHALLENGE_FINISH_RESERVE_MS).toBeGreaterThanOrEqual(5_000 + 2_000)
  })
})
