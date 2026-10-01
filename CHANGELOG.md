# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.10] - 2026-09-29

### Fixed

- **A status-only HTTP response is now a result, not a `WEB_PROVIDER_ERROR`** (badcase: `https://httpbin.org/status/404` → `page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE`). The web seam's contract says "a successful network fetch of a non-2xx response is a result, not an error: the status code is part of the fetched resource state", and `dsh-web-fetch-http` honors it — but the Playwright backend let Chromium's *rendering* decisions leak out as fetch failures: some Chromium builds refuse to commit an error-status response whose body is empty (httpbin `/status/N`: `Content-Length: 0`) and fail the whole navigation with `net::ERR_HTTP_RESPONSE_CODE_FAILURE`, and every build aborts a status-only 204/205 document with `net::ERR_ABORTED` (both documented as rendering/API-level decisions in `net_error_list.h`/`NavigationRequest`, not transport errors); the provider then wrapped the throw as `WEB_PROVIDER_ERROR`, so the agent saw a hard error where the tool layer expects `Fetched … (HTTP 404)`. The last main-frame response is now tracked on every fetch — the response arrives (and is recorded) before Chromium fails the navigation, verified against a real browser — and such a failed `goto` is recovered into the status-bearing result (`statusCode` 404/418/500/204…, empty body decoded as the empty string it is; the `denoise` toggle still applies when a body exists). Deliberately NOT recovered: transport errors (no response to recover), our own deadline/abort (still `WEB_FETCH_TIMEOUT`/`WEB_ABORTED`), `ERR_ABORTED` whose tracked status is not 204/205 (downloads, SPA cancels), and a recovered response that is itself a Cloudflare challenge edge (still `WEB_FETCH_CHALLENGE`, keeping the plugin's never-pass-challenge-content invariant). The tracker is now always installed (previously only with `challengeWaitMs > 0`), which changes nothing else: the challenge wait's use of the LAST response stays gated on the feature switch. Full suite (145 tests incl. three real-browser cases — an empty-bodied 404/500 and a genuine Chromium `ERR_ABORTED` on 204 that failed as `WEB_PROVIDER_ERROR` before the fix), typecheck, and build stay green; verified end-to-end against live `https://httpbin.org/status/404` (now `RESULT statusCode=404`).

## [0.2.9] - 2026-09-28

### Fixed

- **The plugin now activates on dsh web hosts whose profile-scope module resolution chokes on tr46's `require("punycode/")`.** dsh ≥ 0.1.7 intercepts Node's CommonJS resolver for every package installed in a profile; its router classifies `punycode/` (the standard npm-package-over-deprecated-builtin idiom used by tr46, reached through jsdom → whatwg-url) as the builtin stem `punycode`, `require.resolve.paths()` answers `null` for a builtin, and the unguarded iteration throws `TypeError: createRequire.resolve.paths is not a function or its return value is not iterable` — killing the whole plugin import and leaving the entry enabled-but-fiberless, shown as 未运行 on the Plugins page (any other plugin whose tree required `punycode/` at load time failed identically; `dsh-web-search-aggregation` and friends survived only because their dependency trees never touch the idiom). Two contained changes, with behavior otherwise identical: jsdom is now loaded lazily on the first denoise call (`loadJsdom` in `src/markdown.ts`, CommonJS `createRequire` so `htmlToMarkdown` stays synchronous), so plugin activation no longer depends on jsdom's import chain surviving host interception at all; and a probe-then-patch compat shim (`src/host-resolve-compat.ts`) installs immediately before that first jsdom load — it wraps the public `Module._resolveFilename` and re-dispatches exactly the `<deprecated builtin>/` request shape with an explicit `paths` list, which every layer of the resolution chain (the host's included) by documented behavior defers to the native resolver, landing on the real npm `punycode`. On healthy hosts the probe resolves the request and no wrapper is ever installed. Full suite (131 tests incl. real-browser integration), typecheck, and build stay green; verified end-to-end against a clone of the affected profile: import succeeds, the denoise pipeline returns real markdown under the same interception that previously crashed, and the entry boots to `fiber=active` with zero startup warnings.

## [0.2.8] - 2026-09-27

### Changed

- **Migrated to the dsh ≥ 0.1.7 plugin-configuration system** (same design as `dsh-web-search-aggregation`): the host's settings service now derives a plugin's settings section from its composition entry's `Config` schema — every field marked `.volatile()` is editable live, and a committed edit is pushed into the running plugin's volatile references without a remount. The plugin therefore no longer installs its own section: `apply()` receives live `Volatile<T>` references (new `PlaywrightPluginConfig` face, `snapshotsOf`/`resolveConfig` in `src/config.ts`) and the provider re-reads them per fetch through the same `() => config()` thunk as before — behavior, defaults, and field semantics are unchanged. `@deepseek-ai/dsh-settings` is gone from peerDependencies (`installSection` and the whole manual section lifecycle no longer exist), and `@deepseek-ai/schemastery` needs `>=3.18.4` for `.volatile()`. On the client, the card moved from the removed `settings.plugin.item` seat (the old 设置 → 插件 → 插件配置 tab and its disclosure-card chrome) to the Plugins page's two seats — `plugins.bundle.config` (the bundle's own package page, keyed `dsh-web-fetch-playwright`) and `plugins.row.config` (the row's configure control, keyed `dsh-web-fetch-playwright#web-fetch-playwright`) — served by one shared controller through the `configForms` service (`ctx.configForms.get('web-fetch-playwright')`, mounts gated by `whileServed`); the old `settingsScope`/`dsh-client-runtime` dependency is gone, writes now ride the shared form's revision-fenced `set`/`unset` boolean contract, and the summary view answers a row's missing-description fallback. devDependencies were aligned to the host generation (`0.1.7-rc.2`, cordis `4.0.4`). Full suite (131 tests incl. real-browser integration), typecheck, and build stay green.

## [0.2.7] - 2026-09-06

### Fixed

- **Boot no longer fails against dsh-settings 0.1.2+** (`dsh web` died with `plugin tree failed to load … The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'installSettingsSection'`). The plugin was built against the 0.1.1-era API whose top-level helpers (`installSettingsSection`, `settingsNamespace`) no longer exist: dsh-settings 0.1.2 moved that behavior onto the settings service itself (`ctx.settings.installSection(owner, ns, schema, entry, hooks)`) and replaced the runtime `settingsNamespace()` factory with the plain `SettingsNamespace` string type. The host resolves a plugin's bare `@deepseek-ai/*` imports against its own module graph (the loader imports entry packages with the host context as resolution parent), so the plugin's local 0.1.1-rc.1 copy never shields it — the moment the host runs dsh-settings ≥0.1.2, ESM's strict named-export check kills the whole plugin tree at link time. `apply()` now follows the same idiom as the shipped providers (see `web-search-deepseek`): the namespace is a literal constant and the section installs through `ctx.inject(['settings'], (settingsCtx) => settingsCtx.settings.installSection(...))`, so `lib/index.js` no longer imports `@deepseek-ai/dsh-settings` at runtime at all. Dependencies were aligned to the host generation: devDependencies to `0.1.2-alpha.5` (plus `@deepseek-ai/dsh-client-store`, which the published ui-slots types import but do not declare — without it `InjectFace`'s `HostObservable` inference silently degrades to `any` and `card.tsx` fails typecheck), `@deepseek-ai/schemastery` to `>=3.18.2`, and the dsh-settings/dsh-web peer ranges tightened to `>=0.1.2-alpha.0 <0.2.8` (older hosts lack `installSection` and can no longer load this plugin). Verified against the host's real module graph: namespace `web-fetch-playwright` registers, the `playwright` fetch provider lands in `ctx.web`, and a committed settings change reaches the provider's config thunk; the full suite (126 tests) stays green.

- **Normal pages of Cloudflare-Bot-Management sites no longer misclassify as challenges** (badcase: `https://openrouter.ai/openai/gpt-6-astra-pro`). Cloudflare injects its passive JavaScript-Detections (JSD) telemetry into EVERY normal page of a protected zone — either as a direct `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js">` or as that URL strung inside a hidden-1x1-iframe bootstrap's inline script text. The URL embeds the `/cdn-cgi/challenge-platform/` prefix, so the content-level marker scan read every such plain-200 real-content page as an interstitial; the live DOM probe then correctly said "not challenged", but the chained-round recheck re-ran the same false positive and overrode it, burning the whole wait budget and all retries and failing with `WEB_FETCH_CHALLENGE` ("last status 200"). The classifier now strips the `scripts/jsd/` telemetry directory before the challenge-platform prefix check (`classifyChallengeHtml`) and the DOM probe excludes it from its script-src scan (`CHALLENGE_DOM_PROBE`); the bare `/cdn-cgi/scripts/jsd/main.js` marker left the list entirely — it is telemetry in every spelling. Real interstitials still classify: they load orchestrate scripts (`/cdn-cgi/challenge-platform/h/…`) plus `window._cf_chl_opt` / `#challenge-*` / the title family, none of which live under `scripts/jsd/` (regression-tested, including an interstitial that carries the JSD script alongside its own orchestrate scripts). Verified live: the openrouter.ai badcase and nowsecure.nl both return their real articles now, and the full suite (126 tests incl. real-browser challenge integration) stays green.

### Removed

- `dsh.plugin.json`, the standalone plugin manifest. Its content was fully redundant with what the host already reads from `package.json` (the `dsh.*` fields plus `cordis.patch.yml` via `dsh.bundle.patch`), and as a second version-carrying file it had already drifted once (0.2.4's lockstep note) — the package manifest is now the single version source. The stale `"dsh.plugin.json"` entry is gone from the `files` list too, so the published tarball no longer claims a file it does not carry.

## [0.2.6] - 2026-08-27

### Fixed

- **Windows `$PATH` discovery works** (issue #1): `findOnPath` split `process.env.PATH` on a literal `:`, but Windows joins PATH entries with `;` — the whole variable read as one bogus directory, so auto-discovering a `playwright` executable (blank `playwrightPath`) never found anything and silently fell through to the bundled `playwright-core`. It now splits on Node's `path.delimiter`, and a regression test scans a multi-directory PATH with the probe in a non-first entry (the case both Windows reproducers in the issue hit).
- **`pnpm build` is cross-platform** (issue #1): the build script cleaned `lib/` with `rm -rf`, which does not exist on Windows PowerShell — `'rm' is not recognized` killed the build before TypeScript declarations or tsdown ever ran, and since `prepare` runs the same script, installing from a git checkout failed on Windows too. The clean step is now `node -e "require('node:fs').rmSync('lib',{recursive:true,force:true})"`, which works everywhere Node does (a follow-up `scripts/clean.mjs` was considered and dropped to keep the pipeline in one place; tsdown's own `clean` cannot replace it — it runs after `tsc` and would delete the declarations just emitted).
- CI now runs the full check (install, typecheck, test, build) on `windows-latest` alongside `ubuntu-latest`, Node 22/24 — so the PATH-split and build-script regressions above cannot land again unnoticed. The tarball content verification stays Linux-only (`/tmp` + `tar`/`grep` piping); it checks npm packaging, not platform behavior.
- Known Windows limitation, documented rather than fixed here: npm/pnpm global installs expose `playwright` as `.cmd`/`.ps1` shims whose upward walk cannot find the package root, so PATH auto-discovery may still land on the bundled core. Setting `playwrightPath` to the package root or a browser executable selects the intended installation; PATHEXT-aware probing is tracked as a follow-up.

## [0.2.5] - 2026-08-25

### Added

- **Bounded Cloudflare-challenge wait** (issue #2): when a navigation lands on a challenge interstitial, the fetch now keeps the **same page and browser context** and waits for the browser's own verification to clear it, instead of returning the interstitial as content (the behavior before this release — with a strict site that meant "Just a moment…" as markdown within ~1s, the real article never captured even though the browser would have passed the check seconds later).
  - Detection is layered with a suspicion gate: the documented `cf-mitigated: challenge` response header (set on every challenge page type), then 403/503 HTML from a `server: cloudflare` edge, then content-level markers — the localized interstitial title family ("Just a moment...", "请稍候…", "Минутку…", …) plus structural markers (`/cdn-cgi/challenge-platform/` scripts, `#challenge-*` elements, `cf-chl-widget-` frames, `window._cf_chl_opt`, the `.footer .footer-inner .ray-id` footer). Markers are attribute/assignment-shaped so an article that merely quotes them stays clean, and the content tier only runs on challenge-compatible responses (`isChallengeCompatibleResponse`: 403/429/503, or `server: cloudflare` / `cf-ray` present) — interstitials never ship a plain 200, so a normal article cannot be misread as a challenge (and normal fetches skip the extra content read entirely). Hard-block pages ("Attention Required!", "you have been blocked" + a `cf-headline`/`cf-error-details` layout) classify separately and fail immediately.
  - During the wait the provider tracks the **last main-frame navigation response** (the real page reloads in after the clear) and probes the live DOM every 500ms, so SPA-style clears (content swapped with no navigation) are captured too; a probe that throws mid-navigation (context destroyed) counts as "still challenged". A clear that lands on a *chained* round (JS test → Turnstile interstitial) is caught by a settled-DOM recheck — content-level, deliberately, so SPA clears whose response stays 403 forever still pass — and consumes one of the retries.
  - Knobs: `challengeWaitMs` (0–60000, default 15000; **0 disables the whole path and restores the exact pre-0.2.5 behavior**) and `challengeRetries` (0–3, default 1 — a same-tab re-navigation whose context keeps any clearance cookies the browser earned). Everything stays inside the 45s per-fetch deadline with a finish reserve; on exhaustion the fetch fails with the new provider-specific `WEB_FETCH_CHALLENGE` code (the web seam's open-string `code` tolerates provider codes) naming the site, budget, and last challenge status.
  - Cookie lifecycle is unchanged by design: isolated fetches' clearance dies with their context (verified: a second isolated fetch is challenged again), profile-mode clearance stays in the remote browser's own profile (verified: a second profile fetch skips the challenge); nothing is exported, copied, or manufactured. No clicking, no CAPTCHA answers, no fingerprint spoofing.
  - Settings card gains a *Cloudflare challenge wait (ms)* number field; `scripts/challenge-demo.mjs` runs a local simulated strict edge through the baseline and the feature for a before/after printout.
- New exports: `classifyChallengeResponse`, `classifyChallengeHtml`, `isChallengeCompatibleResponse`, `CHALLENGE_DOM_PROBE`, `CHALLENGE_TITLE_RE`, `CHALLENGE_POLL_INTERVAL_MS`, `CHALLENGE_FINISH_RESERVE_MS`, `WEB_FETCH_CHALLENGE_CODE`, `DEFAULT_CHALLENGE_WAIT_MS`, `DEFAULT_CHALLENGE_RETRIES`, `effectiveChallengeWaitMs`, `effectiveChallengeRetries`, and the `ChallengeVerdict` type.

## [0.2.4] - 2026-08-25

### Fixed

- Denoise now elides inline `data:` image payloads (`data:image/png;base64,...`) to size placeholders like `![alt](data:image/png;base64,...8.9KB)`. Build tools (Docusaurus/webpack) inline images above a size cutoff straight into the HTML; they survived Readability, DOMPurify, and Turndown as raw base64 — on the onlyoffice.com docs events page that was **65% of the returned body** (100k chars, truncated at the cap). With the placeholder the same page returns 41.8k chars complete. The elision happens in the DOM before extraction, so both the article and whole-document fallback paths apply it; it runs under the denoise toggle only (raw-HTML mode is untouched) and keeps alt text, MIME type, and the approximate size.
- `dsh.plugin.json` version had drifted (still 0.2.2 after the 0.2.3 release); both manifests now move in lockstep at 0.2.4.

## [0.2.3] - 2026-08-24

### Fixed

- The bundle layer no longer pins `searchProvider: deepseek-official` on the `web` row. The pin out-ranked every later layer, so a user's own search-provider bundle could register and stay healthy yet never be selected — and `$DSH_WEB_SEARCH_PROVIDER` was dead config too (the row's config beat the env). The row's whole config is still replaced by the patch (no deep merge), so `searchProvider` is now simply **omitted**: with the base bundle's single registered search provider, auto-selection picks it exactly as before, while any later layer — a user search bundle, the profile/home `cordis.patch.yml`, or `$DSH_WEB_SEARCH_PROVIDER` — is free to pin search. Two usable search providers with no explicit selection still fail loud (`WEB_PROVIDER_AMBIGUOUS`) instead of guessing. Fetch stays pinned to `playwright`; this bundle owns fetch, not search.

## [0.2.2] - 2026-08-24

### Added

- CDP context modes: a new `shareBrowserContext` setting (checkbox *Share the browser context (profile logins)* nested under the Remote CDP option in the plugin-configuration card, default **on**) selects how each CDP fetch is scoped. **Profile mode** (default): each fetch is a tab in the remote browser's default context — its real profile — so cookies/localStorage are shared and the browser's persistent logins apply; the tab closes when the fetch ends, the shared context never closes. **Isolated mode** (unchecked): the previous behavior — a fresh incognito-like context per fetch.
- `effectiveContextMode(config)` and the exported `CdpContextMode` / `CdpAcquireMode` types.
- Popup guard: popups a fetched page spawns (`window.open`) are closed so no tab outlives its fetch in the remote browser.

### Changed

- The fetch lease is now page-scoped: `CdpLease` carries `page` + `persistent`, `CdpConnectionPool.acquire` takes a mode, and `release` closes only what the lease owns (page always; context unless it is the remote default context). The connection-management core (ensure/connect/watch/drop/dispose) is unchanged — a `browser.close()` on a CDP handle only disconnects, so the remote browser always survives.
- Resource-subrequest filtering moved from context level to **page level**, so profile mode never intercepts tabs it does not own (an operator's manual tabs in the same context).
- Local-backend pages are closed explicitly on teardown (previously the page relied on its context's close to take it down).

### Fixed

- Local sessions now close in a defined order — page, context, browser — each grace-bounded, instead of leaving the page to the context-close side effect.
- Partial-failure leaks: an isolated lease whose `newPage()` fails on a live connection now closes the context it just created (it previously stayed open until the whole connection went away), and the local backend closes its launched browser when `newContext()`/`newPage()` fail after a successful launch (a whole Chromium previously stayed running).

### Security

- Profile mode is a semantic upgrade: fetched pages see the remote browser's logged-in identity, and requests they goad the agent into carry its session cookies. README (en/zh) documents the risk notes and the persistent-`user-data-dir` browser setup; the disclosure adds a credentialed-fetch permission entry.

## [0.2.1] - 2026-08-23

### Fixed

- CI no longer fails on every push: the matrix dropped Node 20 and runs on Node 22/24. `pnpm/action-setup` with a floating `version: 11` resolves to pnpm 11.22.0, which requires Node ≥ 22.13 (`node:sqlite`) and crashed the Node 20 job inside `setup-node` before any step ran, with fail-fast cancelling the healthy 22/24 jobs. Node 20 cannot be restored by pinning pnpm alone: the `tsdown` 0.22 build (run by `prepare` on install) also requires Node ≥ 22.18.
- `CONTRIBUTING.md` now states the toolchain needs Node ≥ 22 while the published plugin itself still runs on Node ≥ 20 (no Node 22+ APIs in the runtime code or build output).

## [0.2.0] - 2026-08-21

### Changed

- CDP backend architecture: instead of one `connectOverCDP` per fetch, the provider now keeps a **single shared connection** to the remote browser for its lifetime; each fetch leases an isolated context (a tab) and closes only that. Reconnects automatically when the connection drops or the configured endpoint changes; the connection is dropped on plugin unload. Concurrent fetches therefore cost tabs, not connections or browsers.
- Concurrency is backend-priced: `maxConcurrency` is now optional with backend-dependent defaults — **4** for local (each slot launches a whole Chromium) and **50** for CDP (each slot is a tab in the already-running browser), range widened to 1–200. The settings card explains the auto default; an explicit value still wins.

### Fixed

- `web fetch aborted while waiting for a free browser slot` no longer surfaces as the common failure under parallel `web_fetch` bursts: the CDP default alone covers 50 concurrent tabs, and a queued fetch that gets no slot within 20s fails fast with `WEB_FETCH_TIMEOUT` plus a retry/`maxConcurrency` hint instead of hanging until an abort mislabels it.
- Queue-wait errors translate through the standard taxonomy: the provider's own deadline expiring while queued reports `WEB_FETCH_TIMEOUT`, and a caller cancelling a queued fetch keeps the precise slot message under `WEB_ABORTED`.
- Cleanup hardening: context/browser closes in the fetch teardown are grace-bounded (2s), so a wedged Playwright close can no longer pin a concurrency slot forever (which previously made every later fetch die on the queue), and a queued fetch that fails to acquire never releases a phantom slot.

### Added

- `CdpConnectionPool` (exported): the shared-connection core — one connect under concurrent acquires, per-fetch context leases, liveness probes (`isConnected` + `disconnected`), single reconnect-and-retry, generation-guarded abandonment of connects made stale by an endpoint change or dispose.
- `effectiveMaxConcurrency(config)` and the `DEFAULT_MAX_CONCURRENCY_LOCAL` / `DEFAULT_MAX_CONCURRENCY_CDP` / `MAX_CONCURRENCY_CEILING` constants.
- Provider `dispose()` plus a `ctx.effect` teardown hook in the plugin entry that drops the shared CDP connection on unload.
- Tests: the CDP pool (8 cases), provider-level CDP behavior (one connection, tabs closed per fetch, 50-way tab burst, dead endpoint), queue cases, and a real-Chromium CDP integration smoke (debugging port, denoise fetch, 12-tab concurrent burst) that self-skips without a browser.

## [0.1.1] - 2026-08-21

### Fixed

- Peer ranges for `@deepseek-ai/dsh-settings` and `@deepseek-ai/dsh-web` now carry an explicit prerelease branch (`>=0.1.0-rc.6 <0.2.0 || >=0.1.1-rc.1 <1`): a bare `>=0.1.0-rc.6 <1` silently excludes `0.1.1-rc.1` builds under node-semver's prerelease rule, which would resolve an older host package copy for npm installs.

### Added

- Tests for the client card form model (staging, save writes, failed-save retention, discard, radio/checkbox fields) and GFM edge cases (strikethrough, checkbox lists, table separators).
- `CONTRIBUTING.md`, `SECURITY.md`, GitHub issue/PR templates, and README links to them.

## [0.1.0] - 2026-08-21

### Added

- First public release as a DSH bundle plugin.
- `PlaywrightFetchProvider` registered with `ctx.web` under id `playwright`; the bundle patch pins the web seam's `fetchProvider` to it and enables the `web_fetch` tool with a 60s budget.
- Local backend: path / `$PATH` / bundled `playwright-core` resolution with native-executable sniffing and package-root discovery.
- Remote backend: CDP connect (`connectOverCDP`) with fresh isolated context per fetch.
- Denoise pipeline: jsdom → Mozilla Readability → DOMPurify (layout tags dropped, `KEEP_CONTENT: false`) → Turndown + GFM with `tool-web`-consistent style and table rules.
- Per-fetch deadline (45s), concurrent-fetch semaphore (2), resource-subrequest filtering, 100k body cap, `WEB_*` error taxonomy parity with the shipped HTTP provider.
- Client settings card (*Playwright 网页爬取*) with backend radio, nested path/CDP inputs, denoise checkbox, and zh/en locales.
- Unit tests (config, markdown, playwright resolution, provider over a fake browser) plus a self-skipping real-browser integration smoke.
