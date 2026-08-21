/**
 * GFM coverage of the denoise pipeline against what it actually preserves:
 * strikethrough survives; checkbox form controls are removed by the sanitizer
 * (FORBID_TAGS includes `input`), so task-list markers cannot survive and the
 * list text is kept without them; table alignment markers are dropped by the
 * Readability re-serialization, so separators render plain — the same
 * trade-offs the shipped `tool-web` renderer makes.
 */
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../src/markdown.ts'

describe('htmlToMarkdown GFM', () => {
  it('converts strikethrough to ~~del~~', () => {
    const { markdown } = htmlToMarkdown(
      '<html><body><article><p>Keep <del>this note</del> out of the final draft.</p></article></body></html>',
      'https://example.com/notes',
    )
    expect(markdown).toContain('~~this note~~')
  })

  it('keeps the list text of checkbox lists but drops the form controls', () => {
    const { markdown } = htmlToMarkdown(
      '<html><body><article><h1>Plan</h1><ul>'
      + '<li><input type="checkbox" checked> ship the release</li>'
      + '<li><input type="checkbox"> write the docs</li>'
      + '</ul></article></body></html>',
      'https://example.com/plan',
    )
    expect(markdown).toContain('ship the release')
    expect(markdown).toContain('write the docs')
    // The sanitizer forbids `input` wholesale, so no [x]/[ ] markers survive.
    expect(markdown).not.toContain('[x]')
    expect(markdown).not.toContain('[ ]')
  })

  it('renders GFM table separators (alignment markers are not preserved)', () => {
    const { markdown } = htmlToMarkdown(
      '<html><body><article>'
      + '<table><thead><tr>'
      + '<th align="left">Name</th><th align="center">Region</th><th align="right">Load</th>'
      + '</tr></thead><tbody><tr>'
      + '<td align="left">alpha</td><td align="center">cn-north</td><td align="right">42%</td>'
      + '</tr></tbody></table>'
      + '</article></body></html>',
      'https://example.com/servers',
    )
    expect(markdown).toContain('| Name | Region | Load |')
    expect(markdown).toContain('| --- | --- | --- |')
    expect(markdown).toContain('| alpha | cn-north | 42% |')
  })
})
