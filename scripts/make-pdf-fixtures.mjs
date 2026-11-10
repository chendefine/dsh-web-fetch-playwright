#!/usr/bin/env node
/**
 * Regenerate the PDF fixtures under tests/fixtures/pdf/ (committed; rerun
 * only when the fixtures need to change):
 *
 * - structured.pdf — Chromium `page.pdf()` of a 3-page document exercising
 *   the layout heuristics: a <title> (PDF Info Title), bookmarks (`outline`),
 *   numbered headings, paragraphs (including auto-hyphenated ones), bullet
 *   and numbered lists, a monospace code block, a bordered table, indented
 *   Chinese paragraphs, a paragraph broken across pages, and a running
 *   header/footer with page numbers on every page.
 * - scanned.pdf — a page whose only content is a <canvas> drawing (printed
 *   as an image): no text layer, like a scan.
 * - encrypted.pdf — a hand-written minimal PDF with a Standard security
 *   handler whose user-password check can never pass (pdf.js asks for a
 *   password).
 * - broken.pdf — `%PDF-` magic followed by garbage.
 *
 * Usage: node scripts/make-pdf-fixtures.mjs  (needs a Playwright Chromium)
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const outDir = fileURLToPath(new URL('../tests/fixtures/pdf/', import.meta.url))
mkdirSync(outDir, { recursive: true })

const LOREM = 'Layout analysis turns positioned glyph runs back into readable structure. The extractor groups runs into lines, lines into paragraphs, and recognizes headings from numbering, outline entries, and type size.'

const STRUCTURED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PDF Fixture Handbook</title>
<style>
  body { font-family: 'Liberation Serif', 'Times New Roman', serif; font-size: 11pt; line-height: 1.35; }
  h1 { font-size: 22pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
  p { margin: 0 0 6pt; text-align: justify; }
  p.hyphen { hyphens: auto; width: 38%; }
  pre { font-family: 'Liberation Mono', 'Courier New', monospace; font-size: 9.5pt; }
  table { border-collapse: collapse; } td, th { border: 1px solid #333; padding: 3pt 18pt; }
  .zh { font-family: 'Noto Serif CJK SC', 'Noto Sans CJK SC', serif; }
  .zh p { text-indent: 2em; }
  .break { break-before: page; }
</style></head><body>
<h1>PDF Fixture Handbook</h1>
<p>${LOREM}</p>
<h2>1 Introduction</h2>
<p>${LOREM} ${LOREM}</p>
<p class="hyphen">Internationalization considerations notwithstanding, characteristically incomprehensible typographical constructions demonstrate automatic hyphenation behaviour.</p>
<h2>2 Lists</h2>
<ul>
  <li>First bullet item.</li>
  <li>Second bullet item that is deliberately long enough to wrap onto a second line so the hanging indent continuation is exercised by the extractor.</li>
  <li>Third bullet item.</li>
</ul>
<ol>
  <li>Download the bytes.</li>
  <li>Parse the document.</li>
  <li>Lay out the markdown.</li>
</ol>
<h3>2.1 Code sample</h3>
<pre>function greet(name) {
  if (name) {
    return 'hello ' + name
  }
}</pre>
<h2>3 Data table</h2>
<table>
  <tr><th>Engine</th><th>Pages</th><th>Seconds</th></tr>
  <tr><td>alpha</td><td>12</td><td>0.8</td></tr>
  <tr><td>beta</td><td>40</td><td>2.1</td></tr>
  <tr><td>gamma</td><td>7</td><td>0.3</td></tr>
</table>
<div class="zh">
<h2>4 中文段落</h2>
<p>这是第一段中文内容，用于验证中文字符的提取与段落合并。中文排版通常采用首行缩进两个字符的方式来区分段落，因此提取器需要识别缩进并正确断开段落，同时不能在中文字符之间插入多余的空格。</p>
<p>这是第二段中文内容。它同样足够长，可以折行显示，从而检验跨行合并时中文之间不会出现空格，并且标点符号保持原样。</p>
</div>
<h2 class="break">5 Second page</h2>
${Array.from({ length: 9 }, () => `<p>${LOREM} ${LOREM}</p>`).join('\n')}
<p>This closing paragraph is long enough that it starts near the bottom of the second page and continues on the third page, so the extractor must join the two halves into one paragraph instead of breaking it at the page boundary, even though running headers and footers sit in between them.</p>
<h2>6 Closing notes</h2>
<p>${LOREM}</p>
</body></html>`

const HEADER = `<div style="font-size:8pt;width:100%;text-align:center;font-family:serif">PDF Fixture Handbook — Internal draft</div>`
const FOOTER = `<div style="font-size:8pt;width:100%;text-align:center;font-family:serif">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`

const SCANNED = `<!doctype html><html><body style="margin:0">
<canvas id="c" width="1200" height="1500"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1200, 1500)
  ctx.fillStyle = '#000'; ctx.font = '40px serif'
  for (let i = 0; i < 20; i++) ctx.fillText('Scanned line ' + (i + 1) + ': pixels, not text.', 80, 120 + i * 60)
</script></body></html>`

/** A minimal PDF with an Encrypt dictionary whose password check fails. */
function encryptedPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${'ab'.repeat(32)}> /U <${'cd'.repeat(32)}> /P -44 >>`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 4 0 R /ID [<${'01'.repeat(16)}> <${'01'.repeat(16)}>] >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setContent(STRUCTURED, { waitUntil: 'load' })
  writeFileSync(`${outDir}structured.pdf`, await page.pdf({
    format: 'A4',
    margin: { top: '60px', bottom: '60px', left: '64px', right: '64px' },
    displayHeaderFooter: true,
    headerTemplate: HEADER,
    footerTemplate: FOOTER,
    outline: true,
    tagged: true,
  }))
  await page.setContent(SCANNED, { waitUntil: 'load' })
  writeFileSync(`${outDir}scanned.pdf`, await page.pdf({ format: 'A4' }))
} finally {
  await browser.close()
}
writeFileSync(`${outDir}encrypted.pdf`, encryptedPdf())
writeFileSync(`${outDir}broken.pdf`, Buffer.from('%PDF-1.7\nthis is not really a pdf\n', 'latin1'))
console.log(`fixtures written to ${outDir}`)
