/**
 * Ambient declaration for `@joplin/turndown-plugin-gfm` (untyped on npm).
 * Only the `gfm` plugin function is consumed.
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  /** Register GFM tables/strikethrough/deletion rules on a TurndownService. */
  export function gfm(service: TurndownService): void
}
