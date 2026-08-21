# dsh-web-fetch-playwright

[中文](./README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-web-fetch-playwright) · [GitHub](https://github.com/chendefine/dsh-web-fetch-playwright)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the built-in `web_fetch` tool a **Playwright/CDP backend**: pages are rendered in a real browser, denoised with **Readability + DOMPurify + Turndown + GFM**, and returned as Markdown.

![npm](https://img.shields.io/npm/v/dsh-web-fetch-playwright) ![license](https://img.shields.io/npm/l/dsh-web-fetch-playwright) ![node](https://img.shields.io/node/v/dsh-web-fetch-playwright) ![CI](https://img.shields.io/github/actions/workflow/status/chendefine/dsh-web-fetch-playwright/ci.yml) ![stars](https://img.shields.io/github/stars/chendefine/dsh-web-fetch-playwright)

## Features

- **Real browser rendering** — loads the page the way a user sees it, so client-side rendered (SPA) content is captured, not just the raw HTML.
- **Denoise pipeline** — Mozilla Readability extracts the article, DOMPurify removes layout/noise tags (nav, sidebar, footer, ads, forms), and Turndown with the GFM plugin converts to Markdown with the same style options as the shipped `tool-web` renderer.
- **Two backends** — launch a local Playwright browser, or drive an already-running browser over its DevTools Protocol (CDP) endpoint.
- **Browser resolution** — a configured path, a `playwright` CLI on `$PATH`, or the bundled `playwright-core`; CDP needs no local browser at all.
- **Isolated sessions** — every fetch uses its own browser context; local launches close their browser, CDP connections only disconnect. Nothing outlives the call that opened it.
- **Live configuration** — a settings card (设置 → 插件 → 插件配置) edits the backend and denoise toggle; changes apply to the next fetch without a restart.
- **Budget-aware** — per-fetch deadline (45s), concurrent-fetch semaphore (2 browsers), image/font/media subrequests aborted, body capped at 100k chars.

## How it works

| Half | Location | Responsibility |
| --- | --- | --- |
| Host (server) | `src/` | Registers the fetch provider (id `playwright`) into `ctx.web`; `cordis.patch.yml` pins the web seam's `fetchProvider` to it and enables the `web_fetch` tool with a 60s budget. |
| Browser (client) | `src/client/` | Registers the *Playwright 网页爬取* configuration card, which hot-writes the settings section into `$DSH_HOME/settings.yaml`. |

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = playwright
        ├─ local: resolve (path → $PATH → bundled playwright-core) → chromium.launch
        ├─ cdp:   connectOverCDP(endpoint)
        ├─ page.goto → settle (networkidle, best-effort) → page.content()
        ├─ denoise: jsdom → Readability → DOMPurify → Turndown(GFM)
        └─ Markdown (or raw HTML when denoise is off)
```

## Requirements

- DSH web profile (`dsh web`), Node.js ≥ 20.
- For the **local** backend: a Playwright installation with Chromium, a Chromium-family browser binary, or `playwright-core` with a browser in the default cache.
- For the **CDP** backend: any browser already running with `--remote-debugging-port` (e.g. `chromium --headless --remote-debugging-port=9222`).

## Installation

From the npm registry (prebuilt — no build permission needed):

```sh
dsh plugin --profile web add dsh-web-fetch-playwright
```

From a GitHub repository (source — pnpm runs the `prepare` build; allowlist the package in `profiles/web/pnpm-workspace.yaml` if pnpm blocks the build script):

```sh
dsh plugin --profile web add github:chendefine/dsh-web-fetch-playwright
```

Or through the DSH plugin marketplace (设置 → DSH插件市场) — the repo carries the `dsh-plugin` topic and is indexed automatically.

After a bundle plugin is added to the profile layer stack, **restart `dsh web`** for it to load; uninstall with `dsh plugin --profile web remove dsh-web-fetch-playwright` and restart again.

## Configuration

The settings card (设置 → 插件 → 插件配置 → *Playwright 网页爬取*) edits the `web-fetch-playwright` settings section live:

| Field | Default | Description |
| --- | --- | --- |
| `backend` | `local` | Radio: *Local Playwright* or *Remote CDP endpoint*, each with its own nested input. |
| `playwrightPath` | (blank) | Local backend: path to a `playwright` executable or a Chromium-family browser binary. Blank = discover on `$PATH`, then fall back to the bundled `playwright-core`. |
| `cdpEndpoint` | `127.0.0.1:9222` | Remote backend: `host:port`, `http(s)://…` or `ws(s)://…`. |
| `denoise` | `true` | Run the denoise pipeline; off returns the full rendered HTML for the tool layer to convert. |

Local backend resolution order:

1. The configured path (auto-detected as Playwright CLI or browser binary).
2. A `playwright` executable on `$PATH` (its package knows that installation's browser registry).
3. The bundled `playwright-core` — requires `PLAYWRIGHT_BROWSERS_PATH` or browsers in the default cache; otherwise the error suggests `playwright install chromium`.

CDP mode needs no local browser: it connects fresh per fetch and uses an isolated context, so it never pollutes an existing browser session.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run (browser smoke self-skips without a browser)
pnpm build       # tsc declarations + tsdown (host ESM + client module-registration bundle)
```

Repository layout:

```
src/
├── index.ts               # host entry: registers provider + settings section
├── config.ts              # schemastery schema, CDP endpoint normalizer
├── provider.ts            # WebFetchProvider: navigation, deadline, semaphore, caps
├── markdown.ts            # denoise pipeline (Readability + DOMPurify + Turndown/GFM)
├── playwright-resolve.ts  # local backend discovery (path / $PATH / bundled core)
├── types.ts               # structural Playwright types (runtime module discovered dynamically)
└── client/                # browser half: settings card, form model, locales
tests/                     # unit + provider + browser integration (self-skipping)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the development and release workflow, and [SECURITY.md](./SECURITY.md) for the security model and reporting policy.

## Security

Same stance as the built-in HTTP provider: **no SSRF / private-network protection is implemented** — anything the browser can reach, this provider can fetch. The CDP endpoint is configured from the settings page with no loopback restriction, so only expose the settings page to trusted environments. Fetched pages are rendered locally; no data is sent anywhere beyond the target page itself.

## License

[MIT](./LICENSE) © 2026 chendefine
