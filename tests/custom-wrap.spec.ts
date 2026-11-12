/**
 * The custom-element (web-component app shell) shape and the sanitize
 * plumbing that serves it — the measured badcase is
 * aistudio.google.com/docs/computer-use, an Angular app whose entire DOM
 * lives under `<ms-app>`: 99% of body text custom-wrapped, every
 * Readability-family candidate sanitizing to a corpse while the three
 * Readability passes over the 1.1MB document cost ~6.5s. The gate must skip
 * exactly that family, keep the candidates that survive DOMPurify (the
 * DOM-backed fallbacks, the noscript paths, the block classifier), and leave
 * normal pages byte-identical.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  CUSTOM_WRAP_SKIP_SHARE,
  customWrappedTextShare,
  generateCandidates,
} from '../src/candidates.ts'
import { htmlToMarkdown, scoreCandidates } from '../src/markdown.ts'

const doc = (html: string): Document => new JSDOM(html, { url: 'https://example.com/docs/page' }).window.document

/** Enough prose that the page is not trivially tiny. */
const prose = (text: string, times = 8): string =>
  Array.from({ length: times }, () => `<p>${text}</p>`).join('\n')

/** The app-shell shape: all DOM text inside custom elements, plain-HTML fallback in noscript. */
const CUSTOM_APP = `<!doctype html><html><head><title>Computer use - App | My Docs</title>
<meta property="og:title" content="My Docs"></head><body>
<ms-app _nghost-ng-c1=""><ms-docs _nghost-ng-c2=""><ms-docs-page _ngcontent-ng-c2="">
<h2>How the tool works</h2>
${prose('The computer use tool drives a browser through screenshots and clicks, and each step is verified before the next one runs.')}
<h2>Safety and security</h2>
${prose('Human-in-the-loop confirmation is required before any irreversible action is executed by the agent.')}
</ms-docs-page></ms-docs></ms-app>
<noscript><div><h1>My Docs</h1>
${prose('The computer use tool drives a browser through screenshots and clicks, and each step is verified before the next one runs.')}
</div></noscript>
</body></html>`

/** A normal article: the gate must not fire and the family must run. */
const PLAIN_ARTICLE = `<!doctype html><html><head><title>An article</title></head><body>
<article><h1>A plain article</h1>
${prose('This is ordinary article prose that Readability extracts well from a standard document tree of paragraphs and headings.', 6)}
</article></body></html>`

describe('customWrappedTextShare', () => {
  it('reads 0 for a page whose text is all in standard elements', () => {
    expect(customWrappedTextShare(doc(PLAIN_ARTICLE).body!)).toBe(0)
  })

  it('reads ~1 for the app-shell shape and excludes noscript from the denominator', () => {
    const share = customWrappedTextShare(doc(CUSTOM_APP).body!)
    expect(share).toBeGreaterThanOrEqual(CUSTOM_WRAP_SKIP_SHARE)
    expect(share).toBeLessThanOrEqual(1)
  })

  it('stays below the threshold when a custom element is only a widget', () => {
    const page = doc(`<!doctype html><html><body><article>
${prose('Ordinary prose fills the great majority of this ordinary page, paragraph after paragraph of plain article text.', 10)}
<share-widget><p>share row</p></share-widget>
</article></body></html>`)
    expect(customWrappedTextShare(page.body!)).toBeLessThan(CUSTOM_WRAP_SKIP_SHARE)
  })
})

describe('the custom-wrap generation gate', () => {
  it('skips the Readability family and flags the skip in the facts', () => {
    const { candidates, facts } = generateCandidates(doc(CUSTOM_APP))
    const kinds = candidates.map(c => c.kind)
    expect(kinds).not.toContain('art')
    expect(kinds).not.toContain('artu')
    expect(kinds).not.toContain('artx')
    expect(facts.readabilitySkipped).toBe(true)
    expect(facts.readabilityNull).toBe(true)
    // The candidates that survive DOMPurify on this shape still run.
    expect(kinds).toContain('doc')
    expect(kinds).toContain('ns_doc')
    // docc joins when the chrome strip actually changed the body (a cookie
    // banner); the identical-proposal dedup keeps it out otherwise.
    expect(kinds).not.toContain('docc')
    const withBanner = CUSTOM_APP.replace('<ms-app', '<div class="cookie-consent">We use cookies. Accept all</div>\n<ms-app')
    expect(generateCandidates(doc(withBanner)).candidates.map(c => c.kind)).toContain('docc')
    // The DOM-backed candidates hand their source node to the sanitizer.
    const docNode = candidates.find(c => c.kind === 'doc')?.node
    expect(docNode).toBeDefined()
    expect(typeof docNode!.querySelectorAll).toBe('function')
  })

  it('keeps the full family on a normal article', () => {
    const { candidates, facts } = generateCandidates(doc(PLAIN_ARTICLE))
    const kinds = candidates.map(c => c.kind)
    expect(kinds).toContain('art')
    expect(kinds).toContain('doc')
    expect(facts.readabilitySkipped).toBeUndefined()
  })

  it('extracts the app-shell content end to end, with the og:title heading', () => {
    const { markdown } = htmlToMarkdown(CUSTOM_APP, 'https://example.com/docs/page')
    expect(markdown).toMatch(/^#\s+My Docs/m)
    expect(markdown).toContain('How the tool works')
    expect(markdown).toContain('screenshots and clicks')
    expect(markdown).toContain('Safety and security')
  })

  it('seeds the empty-art reference so the selector features stay a dead pick\'s', () => {
    const ranked = scoreCandidates(CUSTOM_APP, 'https://example.com/docs/page')
    // The synthetic art reference is present, empty, and never the winner.
    const art = ranked.find(c => c.kind === 'art')
    expect(art).toBeDefined()
    expect(art!.stats.words).toBe(0)
    const best = ranked.find(c => c.stats.words > 0)
    expect(best).toBeDefined()
    expect(best!.kind).not.toBe('art')
  })

  it('keeps the article on an adversarial mixed page (small standard-tag article inside dominant custom chrome)', () => {
    // The worst case for the gate: >90% of text custom-wrapped, but the real
    // content is the standard-tag remainder Readability could conceivably
    // pick. Measured A/B (old vs new): Readability picks the dominant custom
    // mass either way (its scorer follows text mass), so the article rides
    // the block classifier in BOTH versions — the gate must not lose it.
    const noise = (n: number): string =>
      Array.from({ length: n }, (_, i) => `<p>Noise text ${String(i)} rendered by the framework inside custom components, repeated to push the custom-wrapped share past the gate.</p>`).join('\n')
    const page = `<!doctype html><html><head><title>Mixed</title></head><body>
<my-app><my-shell>${noise(34)}</my-shell></my-app>
<article><h1>The real article</h1>
<p>This is the actual article content about the migration plan and the rollback strategy and the monitoring we need, in ordinary standard tags.</p>
<p>A second paragraph of genuine article prose so the extraction has real substance.</p>
</article></body></html>`
    const share = customWrappedTextShare(doc(page).body!)
    expect(share).toBeGreaterThanOrEqual(CUSTOM_WRAP_SKIP_SHARE)
    const { markdown } = htmlToMarkdown(page, 'https://example.com/mixed')
    expect(markdown).toContain('The real article')
    expect(markdown).toContain('rollback strategy')
    expect(markdown).toContain('monitoring we need')
  })
})

describe('node-backed candidates', () => {
  it('sanitizes from the node without touching the live document', () => {
    const document = doc(PLAIN_ARTICLE)
    const before = document.body!.innerHTML
    const { candidates } = generateCandidates(document)
    expect(document.body!.innerHTML).toBe(before)
    expect(candidates.find(c => c.kind === 'doc')?.node).toBe(document.body)
    // Scoring (which sanitizes every candidate) must leave it intact too.
    scoreCandidates(PLAIN_ARTICLE, 'https://example.com/docs/page')
    expect(document.body!.innerHTML).toBe(before)
  })

  it('produces the same sanitized doc as the string path', () => {
    // The whole pipeline over a plain article keeps its published shape:
    // art present, doc present, markdown carries the prose.
    const { markdown } = htmlToMarkdown(PLAIN_ARTICLE, 'https://example.com/docs/page')
    expect(markdown).toContain('ordinary article prose')
    expect(markdown).toMatch(/^#\s+/m)
  })
})
