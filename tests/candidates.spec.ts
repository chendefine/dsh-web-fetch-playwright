/**
 * Candidate generation, block classification, and selector plumbing (0.2.20):
 * the heuristics that propose extractions, each checked on the page shape it
 * exists for — noscript server fallbacks (Discourse), the Discourse
 * preloaded post stream, consent banners, repeated product cards — plus the
 * tree inference shared by both learned models and the end-to-end choice on
 * a forum page whose content only exists inside `<noscript>`.
 */
import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import {
  discoursePreloadedHtml, findRecordRegion, generateCandidates, noscriptTextLength, stripPageChrome, unwrapNoscripts,
} from '../src/candidates.ts'
import { blockKey, renderBlocks, segmentBlocks } from '../src/blocks.ts'
import { predictTrees } from '../src/trees.ts'
import { htmlToMarkdown, scoreCandidates } from '../src/markdown.ts'
import { FEATURE_NAMES } from '../src/selector.ts'

const doc = (html: string): Document => new JSDOM(html, { url: 'https://example.com/t/topic/1' }).window.document

const POST = 'This is a long forum reply that discusses the migration plan in detail, including the rollback strategy and the monitoring we need. '

/** Discourse-shaped static snapshot: an empty app shell, the thread in noscript. */
const FORUM_PAGE = `<!doctype html><html><head><title>Migration plan - Community</title>
<meta name="generator" content="Discourse 3.2"></head><body>
<header><a href="/">Community</a> <a href="/latest">Latest</a></header>
<section id="main"><div class="ember-view">Loading…</div></section>
<noscript><div id="topic-content"><h1>Migration plan</h1>
${Array.from({ length: 8 }, (_, i) => `<div class="post"><span class="creator">user${String(i)}</span><p>${POST.repeat(3)}</p></div>`).join('\n')}
</div></noscript>
<footer>Powered by Discourse</footer></body></html>`

describe('noscript fallbacks', () => {
  it('measures and unwraps noscript content into ordinary markup', () => {
    const document = doc(FORUM_PAGE)
    expect(noscriptTextLength(document)).toBeGreaterThan(1_000)
    expect(unwrapNoscripts(document)).toBe(1)
    expect(document.querySelector('noscript')).toBeNull()
    expect(document.querySelectorAll('.post')).toHaveLength(8)
  })

  it('reparses noscript text left by scripting-enabled parsers', () => {
    const document = doc('<body><noscript></noscript></body>')
    const noscript = document.querySelector('noscript')
    noscript!.textContent = '<p>server rendered</p>'
    unwrapNoscripts(document)
    expect(document.querySelector('p')?.textContent).toBe('server rendered')
  })

  it('proposes noscript-unwrapped candidates only when noscript carries text', () => {
    expect(generateCandidates(doc(FORUM_PAGE)).candidates.map(c => c.kind)).toContain('ns_doc')
    const plain = `<body><article><p>${POST.repeat(5)}</p></article><noscript><img src="a.png"></noscript></body>`
    expect(generateCandidates(doc(plain)).candidates.map(c => c.kind)).not.toContain('ns_doc')
  })

  it('returns the thread for a noscript-only forum snapshot (was empty/skeleton)', () => {
    const { markdown } = htmlToMarkdown(FORUM_PAGE, 'https://community.example.com/t/migration-plan/42')
    expect(markdown).toContain('rollback strategy')
    expect(markdown).toContain('user7')
  })
})

describe('Discourse preloaded stream', () => {
  it('rebuilds posts from data-preloaded JSON', () => {
    const topic = JSON.stringify({ post_stream: { posts: [
      { username: 'alice', created_at: '2024-09-05T23:15:00Z', cooked: '<p>First &amp; foremost</p>' },
      { username: 'bob', created_at: '2024-09-06T08:00:00Z', cooked: '<p>Reply</p>' },
    ] } })
    const attr = JSON.stringify({ topic_42: topic }).replace(/"/g, '&quot;')
    const html = discoursePreloadedHtml(doc(`<body><div id="data-preloaded" data-preloaded="${attr}"></div></body>`))
    expect(html).toContain('alice')
    expect(html).toContain('September 5, 2024')
    expect(html).toContain('<p>Reply</p>')
  })

  it('ignores malformed payloads', () => {
    expect(discoursePreloadedHtml(doc('<body><div id="data-preloaded" data-preloaded="{oops"></div></body>'))).toBeNull()
  })
})

describe('page chrome stripping', () => {
  it('removes consent banners by name and by wording, keeps content', () => {
    const document = doc(`<body>
      <div class="cookie-notice">We use cookies. <a>Accept</a></div>
      <div id="x9"><p>We use cookies to improve your experience. Manage preferences or accept all.</p></div>
      <div class="content"><p>${POST.repeat(6)}</p></div>
      <div style="display:none">hidden mega menu</div>
    </body>`)
    stripPageChrome(document.body)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/cookies/)
    expect(text).not.toContain('hidden mega menu')
    expect(text).toContain('rollback strategy')
  })

  it('never strips a chrome-named wrapper that holds most of the page', () => {
    const document = doc(`<body><div class="content-modal"><p>${POST.repeat(6)}</p></div><p>tail</p></body>`)
    stripPageChrome(document.body)
    expect(document.body.textContent).toContain('rollback strategy')
  })
})

describe('record regions', () => {
  it('finds repeated product cards and skips flat menus', () => {
    const cards = Array.from({ length: 6 }, (_, i) => `<li class="card card-${String(i)}"><a href="/p/${String(i)}"><h3>Moisturizer ${String(i)}</h3></a><span class="price">$${String(20 + i)}.00</span></li>`).join('')
    const menu = Array.from({ length: 10 }, (_, i) => `<li class="m"><a href="/c/${String(i)}">Cat ${String(i)}</a></li>`).join('')
    const document = doc(`<body><ul class="menu">${menu}</ul><ul class="grid">${cards}</ul></body>`)
    const region = findRecordRegion(document.body)
    expect(region?.items).toHaveLength(6)
    expect(region?.items[0]?.textContent).toContain('Moisturizer 0')
  })
})

describe('blocks', () => {
  it('assigns text to its nearest block and re-emits kept blocks in order', () => {
    const document = doc('<body><div>intro <b>bold</b><p>para <a href="#">link</a></p><ul><li>one</li><li>two</li></ul></div><nav>skip me</nav></body>')
    const blocks = segmentBlocks(document.body)
    expect(blocks.map(b => blockKey(b.text))).toEqual(['intro bold', 'para link', 'one', 'two'])
    expect(blocks[1]?.linkWords).toBe(1)
    expect(blocks[1]?.links).toBe(1)
    const html = renderBlocks(blocks, [false, true, true, true])
    expect(html).toBe('<p>para <a href="#">link</a></p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>')
  })
})

describe('tree inference', () => {
  const tree = { feature: [0, 0, 0], threshold: [0.5, 0, 0], left: [1, -1, -1], right: [2, -1, -1], value: [0, -1, 2] }
  it('walks splits and sums leaf values with the learning rate', () => {
    expect(predictTrees({ init: 1, learningRate: 0.5, trees: [tree] }, [0])).toBe(0.5)
    expect(predictTrees({ init: 1, learningRate: 0.5, trees: [tree] }, [1])).toBe(2)
  })
})

describe('selector plumbing', () => {
  it('scores every candidate with a full-length feature vector', () => {
    const ranked = scoreCandidates(FORUM_PAGE, 'https://community.example.com/t/migration-plan/42')
    expect(ranked.length).toBeGreaterThan(2)
    for (const candidate of ranked) {
      expect(candidate.vector).toHaveLength(FEATURE_NAMES.length)
      expect(Number.isFinite(candidate.score)).toBe(true)
    }
    expect(ranked.filter(c => c.legacy)).toHaveLength(1)
  })

  it('reports the chosen strategy', () => {
    const result = htmlToMarkdown(`<body><article><h1>T</h1><p>${POST.repeat(8)}</p></article></body>`, 'https://example.com/a')
    expect(result.strategy).toBeDefined()
    expect(result.markdown).toContain('rollback strategy')
  })
})
