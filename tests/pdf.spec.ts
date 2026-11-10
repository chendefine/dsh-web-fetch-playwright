/**
 * PDF → markdown: the byte/type classifiers, the pure layout heuristics
 * over synthetic positioned runs (one rule per case, so a regression names
 * the rule it broke), and the pdf.js path end to end over the committed
 * fixtures (scripts/make-pdf-fixtures.mjs regenerates them).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  extractPdfMarkdown,
  isPdfBytes,
  isPdfContentType,
  layoutPdfMarkdown,
  mayBePdf,
  MAX_PDF_BYTES,
} from '../src/pdf.ts'
import type { PdfDocumentText, PdfOutlineEntry, PdfPageText, PdfTextRun } from '../src/pdf.ts'

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/pdf/${name}`, import.meta.url))))

// ---------------------------------------------------------------------------
// Synthetic page builder: a cursor that types lines top-down on an A4 page.
// ---------------------------------------------------------------------------

const PAGE_HEIGHT = 842
const LEFT = 72
const CHAR = 0.5 // average advance per character, in em

interface RunSpec { text: string; size?: number; bold?: boolean; mono?: boolean; x?: number; dy?: number }

/** One run, width estimated from its length (CJK glyphs are 1em wide). */
function run(text: string, x: number, y: number, size: number, bold = false, mono = false): PdfTextRun {
  const width = [...text].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? 1 : CHAR), 0) * size
  return { text, x, y, width, size, bold, mono }
}

class PageWriter {
  readonly runs: PdfTextRun[] = []
  y = PAGE_HEIGHT - 90

  /** Type one line; `dy` overrides the advance before it (default 1.2em). */
  line(spec: RunSpec | string): this {
    const s = typeof spec === 'string' ? { text: spec } : spec
    const size = s.size ?? 10
    this.y -= s.dy ?? size * 1.2
    this.runs.push(run(s.text, s.x ?? LEFT, this.y, size, s.bold ?? false, s.mono ?? false))
    return this
  }

  /** A line made of several runs placed at explicit x positions (table rows, mixed weights). */
  cells(parts: Array<{ text: string; x: number; bold?: boolean }>, size = 10, dy = size * 1.2): this {
    this.y -= dy
    for (const part of parts) this.runs.push(run(part.text, part.x, this.y, size, part.bold ?? false))
    return this
  }

  gap(em = 1): this {
    this.y -= 10 * em
    return this
  }

  /** A run in the page margin (header near the top, footer near the bottom). */
  margin(text: string, where: 'top' | 'bottom'): this {
    this.runs.push(run(text, LEFT + 180, where === 'top' ? PAGE_HEIGHT - 40 : 40, 8))
    return this
  }

  page(number: number): PdfPageText {
    return { number, bottom: 0, height: PAGE_HEIGHT, runs: this.runs }
  }
}

function doc(pages: PdfPageText[], extra: { title?: string; outline?: PdfOutlineEntry[] } = {}): PdfDocumentText {
  return { pages, totalPages: pages.length, outline: extra.outline ?? [], ...(extra.title !== undefined ? { title: extra.title } : {}) }
}

/** Ten-odd wrapped body lines so the body size / pitch statistics settle. */
function bodyLines(writer: PageWriter, count: number, prefix = 'Body text line'): PageWriter {
  for (let i = 0; i < count; i++) writer.line(`${prefix} ${String(i + 1)} keeps the paragraph going across the full measure of the column and`)
  writer.line(`${prefix} ends here.`)
  return writer
}

// ---------------------------------------------------------------------------

describe('PDF classification helpers', () => {
  it('recognizes PDF magic within the first KiB only', () => {
    expect(isPdfBytes(new TextEncoder().encode('%PDF-1.7\n...'))).toBe(true)
    expect(isPdfBytes(new TextEncoder().encode(`${' '.repeat(100)}%PDF-1.4`))).toBe(true)
    expect(isPdfBytes(new TextEncoder().encode(`${' '.repeat(2000)}%PDF-1.4`))).toBe(false)
    expect(isPdfBytes(new TextEncoder().encode('<html>%PDF</html>'))).toBe(false)
    expect(isPdfBytes(new Uint8Array())).toBe(false)
  })

  it('classifies PDF content types, ignoring parameters and case', () => {
    expect(isPdfContentType('application/pdf')).toBe(true)
    expect(isPdfContentType('Application/PDF; qs=0.001')).toBe(true)
    expect(isPdfContentType('application/x-pdf')).toBe(true)
    expect(isPdfContentType('application/octet-stream')).toBe(false)
    expect(isPdfContentType(undefined)).toBe(false)
  })

  it('flags responses worth sniffing: pdf type, .pdf filename or path, opaque binary', () => {
    expect(mayBePdf({ 'content-type': 'application/pdf' }, 'https://x.test/a')).toBe(true)
    expect(mayBePdf({ 'content-type': 'application/x-whatever', 'content-disposition': 'attachment; filename="report 2026.PDF"' }, 'https://x.test/dl')).toBe(true)
    expect(mayBePdf({ 'content-disposition': "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf" }, 'https://x.test/dl')).toBe(true)
    expect(mayBePdf({ 'content-type': 'application/x-whatever' }, 'https://x.test/files/paper.pdf')).toBe(true)
    expect(mayBePdf({ 'content-type': 'binary/octet-stream' }, 'https://x.test/blob?id=1')).toBe(true)
    expect(mayBePdf({ 'content-type': 'application/zip' }, 'https://x.test/archive.zip')).toBe(false)
    expect(mayBePdf({ 'content-type': 'image/png' }, 'https://x.test/img')).toBe(false)
  })
})

describe('layoutPdfMarkdown heuristics', () => {
  it('ranks larger type into heading levels and keeps the display title as h1', () => {
    const page = new PageWriter()
      .line({ text: 'A Study of Layout', size: 20 })
      .gap(2)
      .line({ text: 'Overview', size: 14 })
    bodyLines(page, 6)
    page.gap().line({ text: 'Details', size: 12 })
    bodyLines(page, 6)
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('# A Study of Layout\n')
    expect(md).toContain('\n## Overview\n')
    expect(md).toContain('\n### Details\n')
  })

  it('derives levels from section numbering on bold body-size headings', () => {
    const page = new PageWriter()
    page.line({ text: '1 Introduction', bold: true })
    bodyLines(page, 5)
    page.gap().line({ text: '1.1 Background', bold: true })
    bodyLines(page, 5)
    page.gap().line({ text: '1.1.1 Prior art', bold: true })
    bodyLines(page, 5)
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('## 1 Introduction')
    expect(md).toContain('### 1.1 Background')
    expect(md).toContain('#### 1.1.1 Prior art')
  })

  it('uses the outline (bookmarks) for levels, and an outline root equal to the title stays h1', () => {
    const page = new PageWriter().line({ text: 'Handbook', size: 24 }).gap(2)
    page.line({ text: 'Getting started', size: 11 })
    bodyLines(page, 5)
    page.gap().line({ text: 'Install steps', size: 11 })
    bodyLines(page, 5)
    const md = layoutPdfMarkdown(doc([page.page(1)], {
      outline: [{ title: 'Handbook', depth: 0 }, { title: 'Getting started', depth: 1 }, { title: 'Install steps', depth: 2 }],
    }))
    expect(md).toContain('# Handbook')
    expect(md).toContain('## Getting started')
    expect(md).toContain('### Install steps')
  })

  it('prepends a plausible metadata title, and skips placeholder ones', () => {
    const body = (): PdfPageText => bodyLines(new PageWriter(), 4).page(1)
    expect(layoutPdfMarkdown(doc([body()], { title: 'Quarterly Report' }))).toMatch(/^# Quarterly Report\n/)
    expect(layoutPdfMarkdown(doc([body()], { title: 'Microsoft Word - draft3.docx' }))).not.toContain('# ')
    expect(layoutPdfMarkdown(doc([body()], { title: 'untitled' }))).not.toContain('# ')
  })

  it('a 3-line notice in larger type is a paragraph, not a heading plus text', () => {
    const page = new PageWriter()
      .line({ text: 'Provided proper attribution is provided, the publisher grants permission to', size: 12, x: 100 })
      .line({ text: 'reproduce the tables and figures in this paper solely for use in scholarly', size: 12, x: 100 })
      .line({ text: 'works.', size: 12, x: 250 })
      .gap(2)
    bodyLines(page, 8)
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).not.toMatch(/^#+ Provided/m)
    expect(md).toContain('permission to reproduce the tables and figures in this paper solely for use in scholarly works.')
  })

  it('splits paragraphs on vertical gaps and first-line indents, and joins wrapped lines', () => {
    const page = new PageWriter()
      .line('First paragraph opens here and runs to the right edge of the column')
      .line('and finishes on its second line.')
      .gap(1.2)
      .line('Second paragraph follows a blank gap and also wraps across the full')
      .line('measure before it ends.')
      .line({ text: 'Third paragraph is introduced by an indent only, running to the', x: LEFT + 20 })
      .line('column edge and closing here.')
    bodyLines(page, 3, 'Filler')
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('\n\nFirst paragraph opens here and runs to the right edge of the column and finishes on its second line.\n\n')
    expect(md).toContain('\n\nSecond paragraph follows a blank gap and also wraps across the full measure before it ends.\n\n')
    expect(md).toContain('\n\nThird paragraph is introduced by an indent only, running to the column edge and closing here.\n\n')
  })

  it('de-hyphenates line breaks, keeping real compounds the document spells elsewhere', () => {
    const page = new PageWriter()
      .line('The representa-')
      .line('tion is pre-')
      .line('trained once, and the state-of-the-art pre-trained model is fine-')
      .line('tuned later with fine-tuned heads.')
    bodyLines(page, 4)
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('The representation is pre-trained once')
    expect(md).toContain('model is fine-tuned later')
  })

  it('joins CJK lines without spaces and collapses letter-spacing', () => {
    // (Radical look-alikes are normalized at ingestion — see the fixture test.)
    const page = new PageWriter()
      .line({ text: '第一章 总 则', x: LEFT + 100 })
      .line({ text: '这是一段中文内容，用于验证中文字符的提取与段落合并，并且', x: LEFT, dy: 20 })
      .line({ text: '不能在折行处插入空格。' })
    for (let i = 0; i < 6; i++) page.line({ text: '这是用来稳定正文字号统计的中文正文内容，长度足够覆盖整个版心的宽度。' })
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('## 第一章总则')
    expect(md).toContain('用于验证中文字符的提取与段落合并，并且不能在折行处插入空格。')
  })

  it('recognizes Chinese enumerated headings (一、 / （一）) when standalone', () => {
    const page = new PageWriter().line({ text: '一、总体要求', x: LEFT + 20 })
    for (let i = 0; i < 4; i++) page.line({ text: '这是正文内容，长度足够覆盖整个版心的宽度，用来稳定正文字号统计。' })
    page.line({ text: '（一）基本原则', x: LEFT + 20, dy: 18 })
    for (let i = 0; i < 4; i++) page.line({ text: '这是正文内容，长度足够覆盖整个版心的宽度，用来稳定正文字号统计。' })
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('## 一、总体要求')
    expect(md).toContain('### （一）基本原则')
  })

  it('drops running headers/footers and page numbers, and joins a paragraph across the page break', () => {
    const pages: PdfPageText[] = []
    for (let n = 1; n <= 3; n++) {
      const writer = new PageWriter().margin('Journal of Layout Studies, Vol. 7', 'top').margin(`Page ${String(n)} of 3`, 'bottom')
      bodyLines(writer, 4, `Page ${String(n)} paragraph`)
      if (n === 1) writer.gap().line('This sentence starts at the bottom of page one and is not')
      if (n === 2) writer.runs.unshift(run('finished until the top of page two.', LEFT, PAGE_HEIGHT - 80, 10))
      pages.push(writer.page(n))
    }
    const md = layoutPdfMarkdown(doc(pages))
    expect(md).not.toContain('Journal of Layout Studies')
    expect(md).not.toMatch(/Page \d of 3/)
    expect(md).toContain('This sentence starts at the bottom of page one and is not finished until the top of page two.')
    expect(md).toContain('<!-- page 2 -->')
    expect(md).toContain('<!-- page 3 -->')
  })

  it('renders bullets (including Symbol-font private-use glyphs) and numbered items as lists', () => {
    const page = new PageWriter()
    bodyLines(page, 3)
    page.gap()
      .line('• First point.')
      .line(' Second point that wraps onto a hanging-indented')
      .line({ text: 'continuation line.', x: LEFT + 12 })
      .line('1. Download the bytes.')
      .line('2. Parse the document.')
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('- First point.\n- Second point that wraps onto a hanging-indented continuation line.')
    expect(md).toContain('1. Download the bytes.\n2. Parse the document.')
  })

  it('fences monospace blocks with their indentation, unless the whole document is monospace', () => {
    const page = new PageWriter()
    bodyLines(page, 5)
    page.gap()
      .line({ text: 'def greet(name):', mono: true })
      .line({ text: 'return name', mono: true, x: LEFT + 4 * CHAR * 10 })
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('```\ndef greet(name):\n    return name\n```')

    const allMono = new PageWriter()
    for (let i = 0; i < 8; i++) allMono.line({ text: `RFC-style plain text line ${String(i)} in a fixed-pitch face.`, mono: true })
    expect(layoutPdfMarkdown(doc([allMono.page(1)]))).not.toContain('```')
  })

  it('builds GFM tables only from rows whose columns line up', () => {
    const page = new PageWriter()
    bodyLines(page, 4)
    page.gap()
    for (const row of [['Engine', 'Pages', 'Seconds'], ['alpha', '12', '0.8'], ['beta', '40', '2.1']]) {
      page.cells(row.map((text, c) => ({ text, x: LEFT + c * 90 })))
    }
    page.gap()
    // A justified line with one wide gap is not a table.
    page.cells([{ text: 'typographical', x: LEFT }, { text: 'constructions', x: LEFT + 120 }])
    page.line('closing words for the paragraph.')
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('| Engine | Pages | Seconds |\n| --- | --- | --- |\n| alpha | 12 | 0.8 |\n| beta | 40 | 2.1 |')
    expect(md).toContain('typographical constructions closing words for the paragraph.')
  })

  it('marks run-in bold leads inline, merging spans split by regular punctuation', () => {
    const page = new PageWriter()
    bodyLines(page, 3)
    page.gap().cells([{ text: 'Model Architecture', x: LEFT, bold: true }, { text: 'The encoder is a stack of identical layers that', x: LEFT + 100 }])
    page.line('process the input in parallel.')
    page.gap().cells([{ text: '一是筹备开好会议', x: LEFT, bold: true }, { text: '，', x: LEFT + 80 }, { text: '推动精神落实', x: LEFT + 90, bold: true }, { text: '。常委会开展专题调研。', x: LEFT + 150 }])
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('**Model Architecture** The encoder is a stack')
    expect(md).toContain('**一是筹备开好会议，推动精神落实**。常委会开展专题调研。')
    expect(md).not.toMatch(/^#+ Model Architecture/m)
  })

  it('treats a standalone bold line as a child heading of the current section', () => {
    const page = new PageWriter().line({ text: '3.1 Pre-training', bold: true })
    bodyLines(page, 4)
    page.gap().line({ text: 'Next sentence prediction', bold: true }).gap(0.5)
    bodyLines(page, 4)
    page.gap().line({ text: 'Masked language model', bold: true }).gap(0.5)
    bodyLines(page, 4)
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('### 3.1 Pre-training')
    expect(md).toContain('#### Next sentence prediction')
    expect(md).toContain('#### Masked language model')
  })

  it('splits table-of-contents entries even when lines run full width', () => {
    const page = new PageWriter()
    page.line('Introduction ........................................ 1')
    page.line('Methods ............................................. 4')
    page.line('关于草案的说明…………………………………… 李宁（１４）')
    page.line('全国人民代表大会宪法和法律委员会的报告……………… （１６）')
    bodyLines(page, 4)
    const md = layoutPdfMarkdown(doc([page.page(1)]))
    expect(md).toContain('\n\nIntroduction ........................................ 1\n\nMethods')
    expect(md).toContain('李宁（１４）\n\n全国人民代表大会')
  })

  it('escapes leading markdown syntax in plain paragraphs', () => {
    const page = new PageWriter()
    bodyLines(page, 3)
    page.gap().line({ text: '# not a heading, just a hash sign in running text that wraps', x: LEFT })
    page.line('to the next line.')
    expect(layoutPdfMarkdown(doc([page.page(1)]))).toContain('\\# not a heading')
  })
})

describe('extractPdfMarkdown (pdf.js over fixtures)', () => {
  it('extracts the Chromium-printed handbook with structure intact', async () => {
    const { markdown, totalPages, pagesRead, truncated } = await extractPdfMarkdown(fixture('structured.pdf'))
    expect(totalPages).toBeGreaterThanOrEqual(3)
    expect(pagesRead).toBe(totalPages)
    expect(truncated).toBe(false)
    // Title (h1 printed + Info title) exactly once; outline-normalized levels.
    expect(markdown.match(/^# PDF Fixture Handbook$/gm)?.length).toBe(1)
    expect(markdown).toContain('## 1 Introduction')
    expect(markdown).toContain('### 2.1 Code sample')
    expect(markdown).toContain('## 6 Closing notes')
    // Auto-hyphenation (U+2010) undone.
    expect(markdown).toContain('Internationalization considerations notwithstanding, characteristically incomprehensible typographical constructions demonstrate automatic hyphenation behaviour.')
    expect(markdown).toContain('1. Download the bytes.\n2. Parse the document.\n3. Lay out the markdown.')
    expect(markdown).toContain("```\nfunction greet(name) {\n  if (name) {\n    return 'hello ' + name\n  }\n}\n```")
    expect(markdown).toContain('| Engine | Pages | Seconds |\n| --- | --- | --- |\n| alpha | 12 | 0.8 |\n| beta | 40 | 2.1 |\n| gamma | 7 | 0.3 |')
    // Chinese: radicals normalized, no spaces at line joins, indent splits paragraphs.
    expect(markdown).toContain('## 4 中文段落')
    expect(markdown).toContain('这是第一段中文内容，用于验证中文字符的提取与段落合并。')
    expect(markdown).toContain('同时不能在中文字符之间插入多余的空格。\n\n这是第二段中文内容。它同样足够长')
    // Running header / footer gone, page provenance kept.
    expect(markdown).not.toContain('Internal draft')
    expect(markdown).not.toMatch(/Page \d+ of \d+/)
    expect(markdown).toContain('<!-- page 2 -->')
  })

  it('stops at the page / character limits and says so', async () => {
    const byPages = await extractPdfMarkdown(fixture('structured.pdf'), { maxPages: 1 })
    expect(byPages.truncated).toBe(true)
    expect(byPages.pagesRead).toBe(1)
    expect(byPages.markdown).toContain('[PDF extraction stopped after page 1 of')
    const byChars = await extractPdfMarkdown(fixture('structured.pdf'), { maxChars: 100 })
    expect(byChars.truncated).toBe(true)
    expect(byChars.pagesRead).toBe(1)
  })

  it('fails a scan without a text layer with WEB_PDF_NO_TEXT', async () => {
    const error = await extractPdfMarkdown(fixture('scanned.pdf')).catch(caught => caught)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PDF_NO_TEXT')
  })

  it('fails a password-protected PDF with WEB_PDF_ENCRYPTED', async () => {
    const error = await extractPdfMarkdown(fixture('encrypted.pdf')).catch(caught => caught)
    expect((error as WebError).code).toBe('WEB_PDF_ENCRYPTED')
  })

  it('fails a broken PDF with WEB_PDF_INVALID', async () => {
    const error = await extractPdfMarkdown(fixture('broken.pdf')).catch(caught => caught)
    expect((error as WebError).code).toBe('WEB_PDF_INVALID')
  })

  it('refuses oversized input before parsing', async () => {
    const error = await extractPdfMarkdown(new Uint8Array(MAX_PDF_BYTES + 1)).catch(caught => caught)
    expect((error as WebError).code).toBe('WEB_PDF_TOO_LARGE')
  })

  it('accepts a Node Buffer (what Playwright returns) without touching the caller\'s bytes', async () => {
    const buffer = readFileSync(fileURLToPath(new URL('./fixtures/pdf/structured.pdf', import.meta.url)))
    const before = buffer.byteLength
    const { markdown } = await extractPdfMarkdown(buffer)
    expect(markdown).toContain('# PDF Fixture Handbook')
    expect(buffer.byteLength).toBe(before)
  })

  it('aborts between pages on the caller\'s signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller gave up'))
    await expect(extractPdfMarkdown(fixture('structured.pdf'), { signal: controller.signal })).rejects.toThrow('caller gave up')
  })
})
