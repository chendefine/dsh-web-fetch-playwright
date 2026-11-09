/**
 * Serialization safety for documents about to be flattened into an HTML
 * string and re-parsed by jsdom: the one in-page cleanup both serialization
 * paths share — the provider's live-document read and the deep-capture
 * walk's merged clone.
 *
 * @module dsh-web-fetch-playwright/strip
 */

/**
 * In-page function that removes non-content scripting subtrees from a
 * document before it is flattened into an HTML string — the live document
 * before `page.content()`, or the deep-capture walk's merged clone before it
 * serializes it itself (`src/autoscroll.ts`).
 *
 * It is evaluated BY SOURCE (`fn.toString()`), so it must stay
 * self-contained: no imports, no module-level references.
 *
 * WHAT goes, and why each removal is output-neutral versus the old pipeline:
 *
 * - `script` — three consumers ever saw script text before, and none loses
 *   it here: Readability's `parse()` deletes script/noscript nodes BEFORE
 *   extraction and scoring (so script text never reached the article or
 *   influenced the scorer); DOMPurify's default allowlist drops script; the
 *   tool layer's renderer removes SCRIPT wholesale on the raw path. What the
 *   removal buys is the reason this exists: a page's runtime JS may rewrite
 *   a data script's text with a literal `</script>` embedded — measured on
 *   techcommunity.microsoft.com (Khoros/Aurora), whose client writes its
 *   Apollo cache back into `script#__NEXT_DATA__` via `JSON.stringify`,
 *   turning the wire's 712 `\u003c` escapes back into raw `<` — and
 *   browsers serialize script text verbatim, so the flattened string ends
 *   that script at the FIRST embedded end tag and re-parses the remaining
 *   ~270KB of JSON as markup. The phantom elements that survive (unknown
 *   tags like `<id>`, anchors full of JSON text) are exactly what
 *   Readability's scorer reads as article mass, so the extracted "article"
 *   is CSS and i18n strings while the real body — still present in the DOM —
 *   loses. No string-level patch can undo this after serialization (the
 *   string is genuinely ambiguous); only the browser's own parse holds the
 *   document's true structure.
 * - `script[type="application/ld+json"]` — KEPT, but defused: Readability
 *   extracts metadata (title/byline/excerpt — e.g. the site-suffix-free
 *   "Remote Desktop Protocol" instead of "… - Wikipedia") from JSON-LD
 *   scripts before removing them, so deleting them would regress the title
 *   on every JSON-LD-carrying page. Rewriting `</` as `<\/` keeps the text
 *   valid JSON (`\/` is a legal escape, so the re-parsed text parses to the
 *   same object) while making the serialization harmless: the tokenizer
 *   only terminates on a literal `</script`.
 * - `noscript` — KEPT: Readability's `_unwrapNoscriptImages` salvages the
 *   real image out of lazy-load `<noscript><img …>` wrappers before
 *   `_removeScripts` deletes the noscript; pre-stripping it would silently
 *   drop those images from the markdown.
 * - `template` — removed: its children parse into the inert `.content`
 *   fragment (invisible to Readability's traversal), DOMPurify's
 *   FORBID_TAGS drops it, and the tool layer's renderer removes it too.
 * - `style` stays — its text cannot terminate a re-parse except at its own
 *   end tag, and the pipeline already drops it.
 */
export function stripScriptingElementsIn(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('script, template'))) {
    if (el.tagName === 'SCRIPT' && (el.getAttribute('type') ?? '').trim().toLowerCase() === 'application/ld+json') {
      // '<\/' is still valid JSON, so the re-parsed textContent parses to the
      // same object — while the serialized form can no longer close the
      // script element early.
      el.textContent = (el.textContent ?? '').replace(/<\//g, '<\\/')
      continue
    }
    el.remove()
  }
}

/** {@link stripScriptingElementsIn} over the live document, as an evaluate expression. */
export const STRIP_SCRIPTING_ELEMENTS = `(${stripScriptingElementsIn.toString()})(document)`
