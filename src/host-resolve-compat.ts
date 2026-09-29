/**
 * Host resolve compat for the `punycode/` builtin-slash idiom.
 *
 * dsh web (runtime resolution in `dsh-app-boot`) intercepts Node's CommonJS
 * resolver for every package installed in a profile. Its router classifies a
 * bare request by stripping one trailing path segment, which turns tr46's
 * `require("punycode/")` — the standard npm-package-over-deprecated-builtin
 * idiom — into the builtin name `punycode`, and `require.resolve.paths()` of a
 * builtin returns `null`; the unguarded iteration then throws
 * `TypeError: createRequire.resolve.paths is not a function or its return
 * value is not iterable`, killing the whole `jsdom` import chain (jsdom →
 * whatwg-url → tr46) and with it this plugin's activation.
 *
 * The shim below is installed lazily, immediately before the first `jsdom`
 * load, and only when the running resolver actually exhibits the failure
 * (probed with the very request that breaks). It wraps the public
 * `Module._resolveFilename` — whatever it currently is, native or already
 * host-intercepted — and re-dispatches exactly the affected request shape
 * (`<deprecated builtin>/`) with an explicit `paths` list. An explicit
 * `options.paths` is the documented bypass of every resolution interceptor in
 * the chain (the host wrapper delegates straight to the native resolver for
 * it), so the request lands on the real npm package — the same file plain
 * Node would have found. Hosts without the bug never see the wrapper at all;
 * the probe itself changes nothing.
 *
 * The ESM flavor of the same router path exists in theory (`import
 * 'punycode/'`), but nothing in this plugin's tree imports it that way —
 * tr46 is CommonJS — so the CommonJS hook is the complete fix here.
 *
 * @module dsh-web-fetch-playwright/host-resolve-compat
 */

import { createRequire, isBuiltin } from 'node:module'
import { fileURLToPath } from 'node:url'

/** `createRequire` anchored at this module, wherever the bundle is installed. */
const require_ = createRequire(import.meta.url)

/** This file's own path, the anchor the probe resolves from. */
const SELF_FILENAME = fileURLToPath(import.meta.url)

/**
 * Whether a request is the npm-over-builtin idiom: one bare package name with
 * a single trailing slash, whose stem is a Node builtin (today, in practice:
 * `punycode/`).
 * @param request - the module request seen by `Module._resolveFilename`.
 * @returns `true` for `punycode/`-shaped requests; relative paths, scoped
 * names, subpaths, and ordinary packages all answer `false`.
 */
function isBuiltinSlashRequest(request: string): boolean {
  if (request.length < 2 || !request.endsWith('/')) return false
  const first = request.charAt(0)
  if (first === '' || './#@'.includes(first)) return false
  const stem = request.slice(0, -1)
  return stem !== '' && !stem.includes('/') && isBuiltin(stem)
}

/** Probe outcome once known: `true` = shim installed or verified unneeded. */
let settled = false

/**
 * Make `require("<deprecated builtin>/")` resolvable under hosts whose
 * profile-scope resolution interceptor mishandles it. Idempotent, synchronous,
 * and a no-op on healthy resolvers (the probe resolves successfully and no
 * wrapper is installed). Must run before the first `require('jsdom')`.
 */
export function installBuiltinSlashResolveCompat(): void {
  if (settled) return
  settled = true
  const ModuleClass = require_('node:module').Module as {
    _resolveFilename?: (request: string, parent: unknown, main?: boolean, options?: { paths?: string[] }) => string
  }
  const original = ModuleClass._resolveFilename
  if (typeof original !== 'function') return

  // Probe with the exact request that breaks. Resolving it (or failing with
  // plain MODULE_NOT_FOUND on a tree that lacks the npm twin — where a
  // wrapper could not help either) means the host needs no help.
  try {
    original.call(ModuleClass, 'punycode/', { filename: SELF_FILENAME })
    return
  } catch (error) {
    if (!(error instanceof TypeError)) return
    /* the compat case: install the wrapper below */
  }

  // The anchor list a native lookup would use from this module's position:
  // this plugin's nested node_modules first, then the profile's hoisted root
  // where `punycode` actually lives in a pnpm install.
  const searchPaths = require_.resolve.paths('jsdom') ?? []

  ModuleClass._resolveFilename = function patchedResolveFilename(
    this: unknown, request: string, parent: unknown, main?: boolean, options?: { paths?: string[] },
  ): string {
    if (options?.paths === undefined && typeof request === 'string' && isBuiltinSlashRequest(request)) {
      // `paths` set → every layer in the chain (including the host's) defers
      // to the native resolver against exactly these anchors.
      return original.call(ModuleClass, request, parent, main, { ...options, paths: searchPaths })
    }
    return original.call(ModuleClass, request, parent, main, options)
  }
}
