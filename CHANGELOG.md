# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
