/**
 * Learned candidate selector: page-level + candidate-level features → an
 * estimated word-F1 per candidate (gradient-boosted regression trees trained
 * offline by `benchmark/train-selector.py`); the pipeline returns the
 * candidate with the highest estimate.
 *
 * Page features double as a page-type signal (generator meta, JSON-LD
 * `@type`, `og:type`, URL shape, DOM statistics), so the trees learn
 * type-conditional choices — "prune on articles, keep the link directory on
 * docs", "unwrap noscript on forums only" — that no single global threshold
 * could express.
 *
 * @module dsh-web-fetch-playwright/selector
 */

import { CANDIDATE_KINDS, type CandidateKind, type GenerationFacts, NOISE_SUBTREE_TAGS } from './candidates.ts'
import { SELECTOR_MODEL } from './selector-model.ts'
import { blockKey, segmentBlocks, WORD } from './blocks.ts'
import { predictTrees, type TreeEnsemble } from './trees.ts'

/** Text statistics of one sanitized candidate. */
export interface CandidateStats {
  kind: CandidateKind
  legacy: boolean
  words: number
  linkWords: number
  paragraphs: number
  headings: number
  listItems: number
  tableCells: number
  pres: number
  images: number
  blocks: number
  tokens: Set<string>
  consentHits: number
  /** Text blocks as (key, words, linked words), for block-level diffs. */
  blockList: { key: string, words: number, linkWords: number }[]
}

const CONSENT_WORDS = /\b(cookies?|consent|datenschutz|privacy|einwilligung|akzeptieren|accept)\b/gi

/** Measure one sanitized candidate body. */
export function measureCandidate(kind: CandidateKind, legacy: boolean, root: Element): CandidateStats {
  let words = 0
  let linkWords = 0
  const tokens = new Set<string>()
  let head = ''
  const visit = (node: Node, inAnchor: boolean): void => {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? ''
      const matches = text.toLowerCase().match(WORD)
      if (matches !== null) {
        words += matches.length
        if (inAnchor) linkWords += matches.length
        if (tokens.size < 20_000) for (const token of matches) tokens.add(token)
      }
      if (head.length < 600) head += ` ${text}`
      return
    }
    if (node.nodeType !== 1 || NOISE_SUBTREE_TAGS.has(node.nodeName.toLowerCase())) return
    const anchor = inAnchor || node.nodeName === 'A'
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child, anchor)
  }
  visit(root, false)
  const count = (selector: string): number => root.querySelectorAll(selector).length
  const paragraphs = count('p')
  const listItems = count('li')
  const headings = count('h1,h2,h3,h4,h5,h6')
  const tableCells = count('td,th')
  return {
    kind,
    legacy,
    words,
    linkWords,
    paragraphs,
    headings,
    listItems,
    tableCells,
    pres: count('pre'),
    images: count('img'),
    blocks: paragraphs + listItems + headings + tableCells + count('div,section,article,blockquote,dd,dt'),
    tokens,
    consentHits: (head.match(CONSENT_WORDS) ?? []).length,
    blockList: segmentBlocks(root).map(block => ({ key: blockKey(block.text), words: block.words, linkWords: block.linkWords })),
  }
}

/** Page-shape regexes over the URL. */
const URL_SHAPES: [string, RegExp][] = [
  ['product', /\/(products?|p|dp|item|itm|artikel|produkt)\/|[?&](pid|sku|product)=/i],
  ['collection', /\/(collections?|categor(y|ies)|shop|c|catalog|kategorie|brands?|department)\b/i],
  ['docs', /\/(docs?|documentation|api|reference|guides?|manual|tutorials?|learn|wiki)\b|^https?:\/\/(docs|developer|developers|wiki)\./i],
  ['forum', /\/(t|threads?|forums?|topics?|discussions?|questions|community|comments)\b|^https?:\/\/(community|forum|forums|discuss|answers)\./i],
  ['article', /\/(20\d\d|19\d\d)\/|\/(blog|news|articles?|story|stories|posts?|press)\b/i],
  ['search', /\/search\b|[?&](q|query|s|keyword)=/i],
]

const GENERATORS: [string, RegExp][] = [
  ['discourse', /discourse/i],
  ['wordpress', /wordpress/i],
  ['shop', /shopify|woocommerce|magento|prestashop|shopware/i],
  ['forumsw', /flarum|xenforo|vbulletin|phpbb|discuz|invision|mybb|nodebb/i],
  ['docsgen', /sphinx|docusaurus|mkdocs|hugo|gitbook|jekyll|vitepress|mediawiki|readthedocs/i],
  ['cms', /drupal|joomla|ghost|wix|squarespace|hubspot|webflow/i],
]

const JSONLD_TYPES: [string, RegExp][] = [
  ['product', /"@type"\s*:\s*"?(Product|Offer|AggregateOffer|ProductGroup)/],
  ['article', /"@type"\s*:\s*"?(Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle)/],
  ['forum', /"@type"\s*:\s*"?(DiscussionForumPosting|QAPage|Question|SocialMediaPosting|Comment)/],
  ['list', /"@type"\s*:\s*"?(ItemList|CollectionPage|SearchResultsPage|OfferCatalog)/],
  ['faq', /"@type"\s*:\s*"?(FAQPage|HowTo)/],
  ['org', /"@type"\s*:\s*"?(Service|LocalBusiness|Organization|Corporation|EducationalOrganization|Course|Event)/],
  ['breadcrumb', /"@type"\s*:\s*"?BreadcrumbList/],
]

const PRICE = /(?:[$€£¥₹]\s?\d|\d[\d.,]*\s?(?:€|EUR|USD|zł|kr|CHF))/g

/** Page-level feature names, in vector order. */
export const PAGE_FEATURES = [
  'body_words_log', 'noscript_share', 'body_link_density', 'readability_null', 'gate_pass', 'prune_changed',
  'has_main', 'has_preloaded', 'record_items_log', 'record_share',
  ...URL_SHAPES.map(([name]) => `url_${name}`), 'url_depth', 'url_root',
  ...GENERATORS.map(([name]) => `gen_${name}`),
  ...JSONLD_TYPES.map(([name]) => `ld_${name}`),
  'og_article', 'og_product', 'og_website',
  'n_article_log', 'n_h1', 'n_h2_log', 'n_pre_log', 'n_time_log', 'n_form_log', 'n_price_log',
  'n_itemprop_price', 'n_product_itemtype', 'n_post_class_log', 'n_table_log', 'n_code_log', 'n_card_class_log',
] as const

/** Candidate-level feature names, in vector order (one-hot kinds appended). */
export const CANDIDATE_FEATURES = [
  'words_log', 'words_vs_doc', 'words_vs_max', 'words_vs_art_log', 'link_density', 'paragraphs_log', 'headings_log',
  'li_share', 'td_log', 'pre_log', 'img_log', 'words_per_block', 'precision_vs_art', 'recall_vs_art',
  'precision_vs_doc', 'consent_hits', 'legacy',
  'extra_share', 'extra_link_density', 'extra_long_log', 'extra_words_per_block', 'missing_share',
  ...CANDIDATE_KINDS.map(kind => `kind_${kind}`),
] as const

export const FEATURE_NAMES = [...PAGE_FEATURES, ...CANDIDATE_FEATURES]

const log1p = Math.log1p

/** Compute the page feature vector. */
export function pageFeatures(document: Document, url: string, facts: GenerationFacts, doc: CandidateStats | undefined, bodyText: number): number[] {
  const bodyWords = doc?.words ?? 0
  const count = (selector: string): number => document.querySelectorAll(selector).length
  const generator = Array.from(document.querySelectorAll('meta[name="generator" i]'), meta => meta.getAttribute('content') ?? '').join(' ')
    + (document.querySelector('#data-preloaded, meta[name="discourse_theme_id"], .ember-application') !== null ? ' discourse' : '')
  const jsonld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'), script => script.textContent ?? '').join('\n')
  const ogType = (document.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? '').toLowerCase()
  let path = ''
  try { path = new URL(url).pathname } catch { /* keep empty */ }
  const bodyTextContent = document.body?.textContent ?? ''
  const prices = bodyTextContent.length > 2_000_000 ? 0 : (bodyTextContent.match(PRICE) ?? []).length
  return [
    log1p(bodyWords),
    facts.noscriptText / Math.max(1, bodyText + facts.noscriptText),
    doc === undefined || doc.words === 0 ? 0 : doc.linkWords / doc.words,
    facts.readabilityNull ? 1 : 0,
    facts.gatePass ? 1 : 0,
    facts.pruneChanged ? 1 : 0,
    facts.hasMain ? 1 : 0,
    facts.hasPreloaded ? 1 : 0,
    log1p(facts.record?.items.length ?? 0),
    (facts.record?.text ?? 0) / Math.max(1, bodyText),
    ...URL_SHAPES.map(([, pattern]) => pattern.test(url) ? 1 : 0),
    path.split('/').filter(Boolean).length,
    path === '/' || path === '' ? 1 : 0,
    ...GENERATORS.map(([, pattern]) => pattern.test(generator) ? 1 : 0),
    ...JSONLD_TYPES.map(([, pattern]) => pattern.test(jsonld) ? 1 : 0),
    ogType.includes('article') ? 1 : 0,
    ogType.includes('product') ? 1 : 0,
    ogType === 'website' ? 1 : 0,
    log1p(count('article')),
    count('h1'),
    log1p(count('h2')),
    log1p(count('pre')),
    log1p(count('time')),
    log1p(count('form')),
    log1p(prices),
    count('[itemprop="price"]') > 0 ? 1 : 0,
    count('[itemtype*="Product" i]') > 0 ? 1 : 0,
    log1p(count('[class*="post" i], [class*="comment" i], [class*="reply" i]')),
    log1p(count('table')),
    log1p(count('code')),
    log1p(count('[class*="card" i], [class*="product" i], [class*="tile" i]')),
  ]
}

function overlap(tokens: Set<string>, reference: Set<string> | undefined): number {
  if (reference === undefined || tokens.size === 0) return 0
  let hit = 0
  for (const token of tokens) if (reference.has(token)) hit++
  return hit / tokens.size
}

/**
 * How a candidate differs from Readability's pick, block by block: the
 * blocks it adds (long prose → content Readability missed; short link-dense
 * rows → chrome) and the share of Readability's blocks it drops.
 */
function blockDiff(stats: CandidateStats, art: CandidateStats | undefined): number[] {
  if (art === undefined) return [0, 0, 0, 0, 0]
  const artKeys = new Set(art.blockList.map(block => block.key))
  const ownKeys = new Set(stats.blockList.map(block => block.key))
  let total = 0
  let extraWords = 0
  let extraLinks = 0
  let extraLong = 0
  let extraBlocks = 0
  for (const block of stats.blockList) {
    total += block.words
    if (artKeys.has(block.key)) continue
    extraWords += block.words
    extraLinks += block.linkWords
    extraBlocks++
    if (block.words >= 30) extraLong++
  }
  let artTotal = 0
  let missing = 0
  for (const block of art.blockList) {
    artTotal += block.words
    if (!ownKeys.has(block.key)) missing += block.words
  }
  return [
    extraWords / Math.max(1, total),
    extraWords === 0 ? 0 : extraLinks / extraWords,
    Math.log1p(extraLong),
    extraBlocks === 0 ? 0 : extraWords / extraBlocks,
    missing / Math.max(1, artTotal),
  ]
}

/** Compute one candidate's feature vector (page vector excluded). */
export function candidateFeatures(stats: CandidateStats, all: CandidateStats[]): number[] {
  const doc = all.find(c => c.kind === 'doc')
  const art = all.find(c => c.kind === 'art')
  const maxWords = Math.max(1, ...all.map(c => c.words))
  return [
    log1p(stats.words),
    stats.words / Math.max(1, doc?.words ?? 0),
    stats.words / maxWords,
    art === undefined ? 0 : Math.log((stats.words + 1) / (art.words + 1)),
    stats.words === 0 ? 0 : stats.linkWords / stats.words,
    log1p(stats.paragraphs),
    log1p(stats.headings),
    stats.listItems / Math.max(1, stats.blocks),
    log1p(stats.tableCells),
    log1p(stats.pres),
    log1p(stats.images),
    stats.words / Math.max(1, stats.blocks),
    overlap(stats.tokens, art?.tokens),
    art === undefined ? 0 : overlap(art.tokens, stats.tokens),
    overlap(stats.tokens, doc?.tokens),
    stats.consentHits,
    stats.legacy ? 1 : 0,
    ...blockDiff(stats, art),
    ...CANDIDATE_KINDS.map(kind => kind === stats.kind ? 1 : 0),
  ]
}

/** A trained gradient-boosted regressor. */
export interface SelectorModel extends TreeEnsemble {
  version: string
  features: readonly string[]
  /** Estimate lead another candidate needs over the legacy pick to replace it. */
  margin?: number
}

/** Estimated quality of one candidate; falls back to the legacy choice without a model. */
export function scoreCandidate(vector: number[], model: SelectorModel = SELECTOR_MODEL): number {
  if (model.trees.length === 0) {
    return vector[FEATURE_NAMES.indexOf('legacy')] ?? 0
  }
  return predictTrees(model, vector) + (vector[FEATURE_NAMES.indexOf('legacy')] === 1 ? model.margin ?? 0 : 0)
}
