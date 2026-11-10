/**
 * Block-level content classification — the `blk` candidate.
 *
 * Readability picks ONE container, so pages whose content is spread across
 * many sections (service pages, product pages with spec blocks) lose recall,
 * while the whole-document fallback keeps everything and loses precision.
 * Here every text block (the text a block element owns directly) is scored
 * independently by gradient-boosted trees (trained offline by
 * `benchmark/train-blocks.py` on WCXB + ScrapingHub ground truth), and the
 * kept blocks are re-emitted in document order — recall and precision are
 * traded per block instead of per container.
 *
 * @module dsh-web-fetch-playwright/blocks
 */

import { NOISE_SUBTREE_TAGS } from './candidates.ts'
import { BLOCK_MODEL } from './block-model.ts'
import { predictTrees, type TreeEnsemble } from './trees.ts'

/** Elements that start a new text block. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'pre', 'blockquote', 'dd', 'dt',
  'section', 'article', 'main', 'figcaption', 'caption', 'ul', 'ol', 'table', 'tr', 'tbody', 'thead',
  'dl', 'figure', 'address', 'center', 'body',
])

const WORD = /[\p{L}\p{N}_]+/gu
const NEGATIVE_NAMES = /(^|[\s_-])(nav|navbar|menu|footer|header|sidebar|side|widget|related|recommend\w*|share|social|comments?|cookie\w*|consent|banner|promo|ad|ads|advert\w*|breadcrumbs?|pagination|pager|tags?|meta|subscribe|newsletter|login|signup|modal|popup|toolbar|skip)([\s_-]|$)/i
const POSITIVE_NAMES = /(^|[\s_-])(content|article|post|entry|body|text|story|description|desc|product|details?|main|prose|markdown|rte|copy|summary|answer|question|message|thread)([\s_-]|$)/i
const PRICE = /[$€£¥₹]\s?\d|\d\s?(€|EUR|USD)/

/** One text block. */
export interface Block {
  element: Element
  tag: string
  text: string
  words: number
  linkWords: number
  links: number
  depth: number
  negative: boolean
  positive: boolean
  inMain: boolean
  inRecord: boolean
}

/** Normalized key used to match a block against another extraction's blocks. */
export function blockKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 300)
}

/**
 * Split `root` into text blocks: each text node belongs to its nearest
 * block-level ancestor, and a block is an element with directly owned text.
 */
export function segmentBlocks(root: Element, main: Element | null = null, recordItems: Set<Element> = new Set()): Block[] {
  const blocks: Block[] = []
  const open = new Map<Element, Block>()
  const anchors = new Map<Element, number>()
  const visit = (node: Node, block: Element, depth: number, inAnchor: boolean, negative: boolean, positive: boolean, inMain: boolean, inRecord: boolean): void => {
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? ''
      if (text.trim() === '') return
      let entry = open.get(block)
      if (entry === undefined) {
        entry = { element: block, tag: block.nodeName.toLowerCase(), text: '', words: 0, linkWords: 0, links: 0, depth, negative, positive, inMain, inRecord }
        open.set(block, entry)
        blocks.push(entry)
      }
      entry.text += text
      const words = (text.match(WORD) ?? []).length
      entry.words += words
      if (inAnchor) entry.linkWords += words
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    const name = element.nodeName.toLowerCase()
    if (NOISE_SUBTREE_TAGS.has(name)) return
    const isBlock = BLOCK_TAGS.has(name)
    const names = `${element.getAttribute('class') ?? ''} ${element.id}`
    const nextNegative = negative || (names.length > 1 && NEGATIVE_NAMES.test(names))
    const nextPositive = positive || (names.length > 1 && POSITIVE_NAMES.test(names))
    const nextMain = inMain || element === main
    const nextRecord = inRecord || recordItems.has(element)
    if (name === 'a') anchors.set(block, (anchors.get(block) ?? 0) + 1)
    const owner = isBlock ? element : block
    for (let child = element.firstChild; child !== null; child = child.nextSibling) {
      visit(child, owner, isBlock ? depth + 1 : depth, inAnchor || name === 'a', nextNegative, nextPositive, nextMain, nextRecord)
    }
  }
  visit(root, root, 0, false, false, false, false, false)
  for (const block of blocks) block.links = anchors.get(block.element) ?? 0
  return blocks
}

/** Block-level feature names (page features are prepended). */
export const BLOCK_FEATURES = [
  'b_words_log', 'b_chars_log', 'b_link_density', 'b_links_log',
  'b_p', 'b_li', 'b_h1', 'b_hx', 'b_td', 'b_pre', 'b_quote', 'b_dd', 'b_div',
  'b_depth', 'b_pos', 'b_in_art', 'b_in_main', 'b_in_record', 'b_negative', 'b_positive',
  'b_punct', 'b_digits', 'b_price', 'b_prev_in_art', 'b_next_in_art', 'b_window_words_log',
  'b_window_link_density', 'b_words_vs_max',
] as const

/** Feature vectors for every block (page vector excluded). */
export function blockFeatures(blocks: Block[], artKeys: Set<string>): number[][] {
  const inArt = blocks.map(block => artKeys.has(blockKey(block.text)) ? 1 : 0)
  const maxWords = Math.max(1, ...blocks.map(block => block.words))
  return blocks.map((block, index) => {
    const tag = block.tag
    let windowWords = 0
    let windowLinks = 0
    for (let j = Math.max(0, index - 3); j <= Math.min(blocks.length - 1, index + 3); j++) {
      windowWords += blocks[j]?.words ?? 0
      windowLinks += blocks[j]?.linkWords ?? 0
    }
    const chars = block.text.replace(/\s+/g, '').length
    return [
      Math.log1p(block.words),
      Math.log1p(chars),
      block.words === 0 ? 0 : block.linkWords / block.words,
      Math.log1p(block.links),
      tag === 'p' ? 1 : 0,
      tag === 'li' ? 1 : 0,
      tag === 'h1' ? 1 : 0,
      /^h[2-6]$/.test(tag) ? 1 : 0,
      tag === 'td' || tag === 'th' ? 1 : 0,
      tag === 'pre' ? 1 : 0,
      tag === 'blockquote' ? 1 : 0,
      tag === 'dd' || tag === 'dt' ? 1 : 0,
      tag === 'div' || tag === 'section' || tag === 'article' ? 1 : 0,
      block.depth,
      blocks.length <= 1 ? 0 : index / (blocks.length - 1),
      inArt[index] ?? 0,
      block.inMain ? 1 : 0,
      block.inRecord ? 1 : 0,
      block.negative ? 1 : 0,
      block.positive ? 1 : 0,
      (block.text.match(/[.!?。！？,，;；:]/g) ?? []).length / Math.max(1, block.words),
      (block.text.match(/\d/g) ?? []).length / Math.max(1, chars),
      PRICE.test(block.text) ? 1 : 0,
      inArt[index - 1] ?? 0,
      inArt[index + 1] ?? 0,
      Math.log1p(windowWords),
      windowWords === 0 ? 0 : windowLinks / windowWords,
      block.words / maxWords,
    ]
  })
}

/** A trained block classifier (log-odds GBDT). */
export interface BlockModel extends TreeEnsemble {
  version: string
  threshold: number
}

let activeModel: BlockModel = BLOCK_MODEL

/** Override the block model (benchmark cross-fitting only). */
export function setBlockModel(model: BlockModel | null): void {
  activeModel = model ?? BLOCK_MODEL
}

/** Whether a block model is available. */
export function hasBlockModel(): boolean {
  return activeModel.trees.length > 0
}

/** Probability that each block is content. */
export function classifyBlocks(vectors: number[][]): number[] {
  return vectors.map(vector => 1 / (1 + Math.exp(-predictTrees(activeModel, vector))))
}

/** Probability cut for keeping a block. */
export function blockThreshold(): number {
  return activeModel.threshold
}

const HEADING = /^h[1-6]$/

/**
 * Re-emit kept blocks as HTML in document order: headings and `pre` keep
 * their tag, list items are grouped into lists, everything else becomes a
 * paragraph of the block's own inline content.
 */
export function renderBlocks(blocks: Block[], keep: boolean[]): string {
  const parts: string[] = []
  let inList = false
  blocks.forEach((block, index) => {
    if (keep[index] !== true) return
    const own = ownInlineHtml(block.element)
    if (block.tag === 'li') {
      if (!inList) parts.push('<ul>')
      inList = true
      parts.push(`<li>${own}</li>`)
      return
    }
    if (inList) parts.push('</ul>')
    inList = false
    if (HEADING.test(block.tag)) parts.push(`<${block.tag}>${own}</${block.tag}>`)
    else if (block.tag === 'pre') parts.push(`<pre>${block.element.innerHTML}</pre>`)
    else parts.push(`<p>${own}</p>`)
  })
  if (inList) parts.push('</ul>')
  return parts.join('\n')
}

/** The element's markup minus nested block elements (their text is their own block). */
function ownInlineHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element
  for (const child of Array.from(clone.querySelectorAll('*'))) {
    if (child.isConnected && BLOCK_TAGS.has(child.nodeName.toLowerCase()) && clone.contains(child)) child.remove()
  }
  return clone.innerHTML
}
