# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
