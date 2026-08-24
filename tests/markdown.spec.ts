/**
 * The denoise pipeline against representative fixture pages: a docs-style
 * article wrapped in nav/sidebar/footer/ads chrome, a table page, and a
 * non-article page that must fall back to whole-document conversion.
 */
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../src/markdown.ts'

/** A typical docs/blog page: header nav, sidebar, article, footer, ad slots. */
const ARTICLE_PAGE = `<!doctype html>
<html><head><title>Playwright guide</title><style>.x{color:red}</style></head>
<body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a></nav>
<aside id="sidebar"><div>Related</div><ul><li><a href="/a">link one</a></li><li><a href="/b">link two</a></li></ul></aside>
<main>
<article>
<h1>Getting started</h1>
<p>Playwright enables reliable end-to-end testing of modern web apps. It works across all major browsers, runs headless or headed, and captures traces for every run.</p>
<h2>Installation</h2>
<p>Install with <code>npm i playwright</code>, then run <code>playwright install</code> once to download the browser binaries the library drives.</p>
<ul><li>Auto-wait for elements</li><li>Network interception</li><li>Multi-browser contexts</li></ul>
<p>See the <a href="https://example.com/docs">full documentation</a> for details.</p>
</article>
</main>
<div class="ad banner-ad"><a href="/buy">BUY NOW — 50% OFF</a></div>
<footer><nav><a href="/tos">Terms</a> <a href="/privacy">Privacy</a></nav>© 2026 Example Corp</footer>
<script>window.tracker = { send: () => {} }</script>
</body></html>`

/** A page whose payload is one GFM table. */
const TABLE_PAGE = `<!doctype html>
<html><head><title>Servers</title></head><body>
<nav>global nav noise</nav>
<main>
<h1>Servers</h1>
<p>Two server regions are currently online and accepting traffic from the control plane.</p>
<table>
<thead><tr><th>Name</th><th>Region</th></tr></thead>
<tbody>
<tr><td>alpha</td><td>cn-north</td></tr>
<tr><td>beta</td><td>us-east</td></tr>
</tbody>
</table>
</main>
<footer>footer noise</footer>
</body></html>`

/** A page with no article structure at all (login-like). */
const NON_ARTICLE_PAGE = `<!doctype html>
<html><head><title>Login</title></head><body>
<nav>nav noise</nav>
<main><h1>Login</h1><form><input name="user"><input name="pass" type="password"><button>Sign in</button></form><p>Session expired, please sign in again. Enter your credentials to continue where you left off.</p></main>
<footer>footer noise</footer>
</body></html>`

/** A build-tool-inlined data URI payload (4096 base64 chars = 3072 bytes). */
const DATA_URI_3KB = `data:image/png;base64,${'A'.repeat(4096)}`

/** A docs article whose build tool inlined its screenshots as data URIs. */
const INLINE_IMAGE_PAGE = `<!doctype html>
<html><head><title>Inline images</title></head><body>
<nav>nav noise</nav>
<main><article>
<h1>Guide</h1>
<p>Intro paragraph with enough text for extraction to latch onto the article region.</p>
<p><img decoding=async loading=lazy alt="tiny chart" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></p>
<p><img alt="big screenshot" title="The screenshot" src="${DATA_URI_3KB}"></p>
<p><img alt="remote photo" src="https://example.com/photo.png"></p>
</article></main>
<footer>footer noise</footer>
</body></html>`

describe('htmlToMarkdown', () => {
  it('extracts the article and drops nav/sidebar/footer/ad chrome', () => {
    const { markdown, mode } = htmlToMarkdown(ARTICLE_PAGE, 'https://example.com/guide')
    expect(mode).toBe('article')
    // The extracted title leads the markdown (Readability kept the article's
    // own heading structure, so the prepended title is the page <title>).
    expect(markdown).toContain('# Playwright guide')
    expect(markdown).toContain('Getting started')
    expect(markdown).toContain('reliable end-to-end testing')
    expect(markdown).toMatch(/-\s+Auto-wait for elements/)
    expect(markdown).toContain('[full documentation](https://example.com/docs)')
    // Chrome must be gone.
    expect(markdown).not.toContain('Home')
    expect(markdown).not.toContain('Related')
    expect(markdown).not.toContain('BUY NOW')
    expect(markdown).not.toContain('Terms')
    expect(markdown).not.toContain('© 2026')
    expect(markdown).not.toContain('window.tracker')
  })

  it('converts GFM tables with a header separator', () => {
    const { markdown } = htmlToMarkdown(TABLE_PAGE, 'https://example.com/servers')
    expect(markdown).toContain('| Name | Region |')
    expect(markdown).toContain('| --- | --- |')
    expect(markdown).toContain('| alpha | cn-north |')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
  })

  it('extracts the meaningful content of sparse pages (login-like)', () => {
    const { markdown, mode } = htmlToMarkdown(NON_ARTICLE_PAGE, 'https://example.com/login')
    // Readability keeps the meaningful paragraph; the form and chrome go.
    expect(mode).toBe('article')
    expect(markdown).toContain('Session expired')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
    expect(markdown).not.toContain('Sign in')
  })

  it('falls back to whole-document conversion when extraction yields nothing', () => {
    const page = `<!doctype html><html><head><title>Empty-ish</title></head><body>
<nav>nav noise</nav>
<main><p>just one plain line of body text</p></main>
<footer>footer noise</footer>
</body></html>`
    // An empty body is the reliable null-parse shape; the pipeline's fallback
    // is exercised by the pathological-input test below.
    const { mode } = htmlToMarkdown('<html><body></body></html>', 'https://example.com/e')
    expect(mode).toBe('document')
    expect(htmlToMarkdown(page, 'https://example.com/p').markdown).toContain('plain line of body text')
  })

  it('elides inline data-URI image payloads to size placeholders', () => {
    const { markdown, mode } = htmlToMarkdown(INLINE_IMAGE_PAGE, 'https://example.com/guide')
    expect(mode).toBe('article')
    // The base64 payloads are gone entirely...
    expect(markdown).not.toContain('iVBORw0KGgo')
    expect(markdown).not.toContain('A'.repeat(64))
    // ...replaced by alt-bearing, MIME-and-size-marked placeholders; the
    // default image rule's title handling still applies to the short src.
    expect(markdown).toMatch(/!\[tiny chart\]\(data:image\/png;base64,...\d+B\)/)
    expect(markdown).toContain('![big screenshot](data:image/png;base64,...3.0KB "The screenshot")')
    // Remote images are untouched.
    expect(markdown).toContain('![remote photo](https://example.com/photo.png)')
  })

  it('elides data-URI images on the whole-document fallback path too', () => {
    const page = `<!doctype html><html><head><title>Sparse</title></head><body>
<img alt="inline diagram" src="${DATA_URI_3KB}">
</body></html>`
    const { markdown, mode } = htmlToMarkdown(page, 'https://example.com/sparse')
    // An image-only body gives Readability nothing to extract: the fallback
    // path must apply the same elision the article path does.
    expect(mode).toBe('document')
    expect(markdown).toContain('![inline diagram](data:image/png;base64,...3.0KB)')
    expect(markdown).not.toContain('A'.repeat(64))
  })

  it('survives pathological input without throwing', () => {
    expect(() => htmlToMarkdown('', 'https://example.com/x')).not.toThrow()
    expect(() => htmlToMarkdown('<html><body>', 'https://example.com/x')).not.toThrow()
    const { markdown } = htmlToMarkdown('<p>hello</p>', 'https://example.com/x')
    expect(markdown.toLowerCase()).toContain('hello')
  })
})
