/**
 * Cloudflare challenge detection: the pure predicates and in-page probe the
 * provider's bounded natural-wait uses. Nothing here talks to a browser,
 * a clock, or the network — every function is a mapping over a response's
 * status/headers or an HTML string, so the whole surface is unit-testable.
 *
 * Detection is layered, strongest signal first:
 *
 * 1. Response-level — Cloudflare documents that EVERY challenge page type
 *    (JS challenge, managed challenge, Turnstile interstitial) carries
 *    `cf-mitigated: challenge`. That header is the primary verdict; a
 *    403/503 from a `server: cloudflare` HTML response is the fallback for
 *    origins that strip it.
 * 2. Content-level — the interstitial's localized `<title>` family
 *    ("Just a moment...", "请稍候…", ...) plus structural markers
 *    (`/cdn-cgi/challenge-platform/` scripts, `#challenge-*` elements,
 *    `cf-chl-widget-` Turnstile frames, `window._cf_chl_opt`). Markers are
 *    deliberately structural: a blog post that merely MENTIONS Cloudflare
 *    must not classify as a challenge.
 *
 * The security stance (issue #2): this module only DETECTS and classifies.
 * Solving, spoofing, CAPTCHA answering, and cookie lifting live outside the
 * plugin entirely.
 *
 * @module dsh-web-fetch-playwright/challenge
 */

/** How often the bounded wait probes the live page for challenge markers. */
export const CHALLENGE_POLL_INTERVAL_MS = 500

/**
 * Tail of the fetch budget held back from the challenge wait so a cleared
 * challenge still has time for its settle (5s networkidle cap) plus the
 * content read and the denoise pipeline.
 */
export const CHALLENGE_FINISH_RESERVE_MS = 8_000

/**
 * The interstitial's localized `<title>` cores, anchored full-match with
 * optional trailing ellipsis/punctuation. Cf. ships dozens of locales; this
 * set covers the major ones — the response header remains the primary
 * signal, so the list only needs to catch header-stripping edges.
 */
const CHALLENGE_TITLE_CORES = [
  'just a moment', // en
  'einen moment', // de
  'un instant', // fr
  'un momento', // es, it
  'um momento', // pt
  'een ogenblik geduld', // nl
  'минуточку', 'минутку', 'пожалуйста, подождите', // ru
  'хвилинку', // uk
  'chwileczkę', // pl
  'chvilku strpení', // cs
  'bir dakika', // tr
  'o clipă', // ro
  'μια στιγμή', // el
  '少し時間がかかります', // ja
  '잠시만요', '잠시 기다려주세요', // ko
  '请稍候', '請稍候', // zh-CN, zh-TW
  'เดี๋ยวก่อน', // th
  'vui lòng chờ', 'chờ một chút', // vi
  'tunggu sebentar', // id
  'لحظة من فضلك', 'الرجاء الانتظار', // ar
  'רק רגע', // he
  'ett ögonblick', // sv
  'et øjeblik', // da
  'et øyeblikk', // no
  'hetkinen', 'pikainen hetki', // fi
  'egy pillanat', // hu
  'моля, изчакайте', // bg
]

/** Escape regex metacharacters in a literal title core. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Anchored, case-insensitive match for the localized interstitial title:
 * one of the cores, then only ellipsis/dot/punctuation noise to the end.
 */
export const CHALLENGE_TITLE_RE = new RegExp(
  `^(?:${CHALLENGE_TITLE_CORES.map(escapeRegExp).join('|')})[\\s.!？?…。！]*$`,
  'i',
)

/**
 * Structural markers a challenge document carries in its HTML. Kept in
 * attribute/assignment form (`id="…"`, `window._cf_chl_opt`) rather than bare
 * substrings so an article that merely QUOTES these strings in prose or code
 * samples does not classify — the marker must look like the real element.
 */
const CHALLENGE_HTML_MARKERS = [
  '/cdn-cgi/challenge-platform/',
  '/cdn-cgi/scripts/jsd/main.js',
  'id="cf-chl-widget-',
  'window._cf_chl_opt',
  'id="challenge-form"',
  'id="challenge-running"',
  'id="challenge-stage"',
  'id="challenge-error-text"',
  'name="cf-challenge"',
  'checking your browser before accessing',
]

/** Title cores of the hard-block page ("Attention Required! | Cloudflare"). */
const BLOCKED_TITLE_RE = /^attention required!/i

/**
 * The hard-block page's body phrase, gated by the structural markers below:
 * the phrase alone must not fail a normal article that happens to contain
 * it in prose.
 */
const BLOCKED_BODY_PHRASE = 'you have been blocked'

/** Structural markers of the hard-block page's classic layout. */
const BLOCKED_BODY_MARKERS = ['cf-headline', 'cf-error-details', 'cf-block-details']

/** The verdicts detection can return. */
export type ChallengeVerdict = 'none' | 'challenge' | 'blocked'

/** Extract and trim a document's `<title>` text, '' when absent. */
function titleOf(html: string): string {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  return (match?.[1] ?? '').trim()
}

/** Whether a content-type mime is an HTML document (challenge pages are). */
function isHtmlMime(contentType: string): boolean {
  const mime = contentType.replace(/;.*$/s, '').trim().toLowerCase()
  return mime === '' || mime === 'text/html' || mime === 'application/xhtml+xml'
}

/**
 * Classify a navigation response from its status and headers.
 *
 * @param status - the response's HTTP status code.
 * @param headers - the response's headers (case as Playwright serves: lowercased).
 * @returns `'challenge'` when the response is a Cloudflare challenge, else `'none'`.
 */
export function classifyChallengeResponse(status: number, headers: Record<string, string>): 'none' | 'challenge' {
  const header = (name: string): string => (headers[name] ?? '').trim().toLowerCase()
  // The documented signal: every challenge page type sets this header.
  if (header('cf-mitigated') === 'challenge') return 'challenge'
  // Fallback for origins that strip it: Cloudflare's own block statuses
  // served as HTML from a Cloudflare edge.
  if ((status === 403 || status === 503) && header('server').includes('cloudflare') && isHtmlMime(header('content-type'))) {
    return 'challenge'
  }
  return 'none'
}

/**
 * Whether a response is even a candidate for the content-level checks —
 * the suspicion gate. Cloudflare interstitials NEVER ship a plain 200 from
 * a non-Cloudflare origin: they are 403/429/503, or served from a Cloudflare
 * edge (`server: cloudflare`, `cf-ray`). Running the title/marker fallback
 * only on such responses means a normal article — whatever it quotes about
 * Cloudflare, in any language — can never be misread as a challenge. This is
 * the tiering the industry converges on: protocol signals first, content
 * markers only as a gated fallback.
 *
 * @param status - the response's HTTP status code.
 * @param headers - the response's headers (lowercased, as Playwright serves).
 * @returns true when the content-level fallback may run.
 */
export function isChallengeCompatibleResponse(status: number, headers: Record<string, string>): boolean {
  if (status === 403 || status === 429 || status === 503) return true
  const header = (name: string): string => (headers[name] ?? '').trim().toLowerCase()
  return header('server').includes('cloudflare') || header('cf-ray') !== ''
}

/**
 * Classify a rendered document from its HTML: the localized interstitial
 * title family and the structural markers above say `challenge`; the
 * hard-block page says `blocked` (waiting cannot clear it — the caller
 * should fail immediately instead of burning its budget).
 *
 * @param html - the document HTML as `page.content()` returns it.
 * @returns the verdict for this HTML.
 */
export function classifyChallengeHtml(html: string): ChallengeVerdict {
  if (html.length === 0) return 'none'
  const title = titleOf(html)
  if (BLOCKED_TITLE_RE.test(title)) return 'blocked'
  const lowered = html.toLowerCase()
  if (lowered.includes(BLOCKED_BODY_PHRASE) && BLOCKED_BODY_MARKERS.some(marker => lowered.includes(marker))) return 'blocked'
  if (CHALLENGE_TITLE_RE.test(title)) return 'challenge'
  if (CHALLENGE_HTML_MARKERS.some(marker => lowered.includes(marker))) return 'challenge'
  // Crawlee's footer marker, as a two-class combo so prose quoting one class
  // alone stays clean.
  if (lowered.includes('class="ray-id"') && lowered.includes('class="footer-inner"')) return 'challenge'
  return 'none'
}

/**
 * The in-page probe the bounded wait runs against the LIVE document (via
 * `page.evaluate`): true while challenge markers are still present. This is
 * what makes SPA-style clears visible — the document swaps its content
 * without any navigation, so only a DOM read can see the change. The title
 * regex is baked in at build time from the same single source the Node-side
 * check uses, so the two can never drift apart.
 */
export const CHALLENGE_DOM_PROBE = `(() => {
  const re = new RegExp(${JSON.stringify(CHALLENGE_TITLE_RE.source)}, ${JSON.stringify(CHALLENGE_TITLE_RE.flags)})
  if (re.test(document.title.trim())) return true
  if (document.querySelector('#challenge-form, #challenge-running, #challenge-stage, #challenge-error-text')) return true
  if (document.querySelector('[id^="cf-chl-widget-"]')) return true
  for (const script of Array.from(document.scripts)) {
    const src = script.getAttribute('src') || ''
    if (src.includes('/cdn-cgi/challenge-platform/') || src.includes('/cdn-cgi/scripts/jsd/main.js')) return true
  }
  if (document.querySelector('.footer .footer-inner .ray-id')) return true
  return false
})()`
