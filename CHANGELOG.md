# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
