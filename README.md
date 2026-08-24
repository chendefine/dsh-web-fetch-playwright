# dsh-web-fetch-playwright

[中文](./README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-web-fetch-playwright) · [GitHub](https://github.com/chendefine/dsh-web-fetch-playwright)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that gives the built-in `web_fetch` tool a **Playwright/CDP backend**: pages are rendered in a real browser, denoised with **Readability + DOMPurify + Turndown + GFM**, and returned as Markdown.

![npm](https://img.shields.io/npm/v/dsh-web-fetch-playwright) ![license](https://img.shields.io/npm/l/dsh-web-fetch-playwright) ![node](https://img.shields.io/node/v/dsh-web-fetch-playwright) ![CI](https://img.shields.io/github/actions/workflow/status/chendefine/dsh-web-fetch-playwright/ci.yml) ![stars](https://img.shields.io/github/stars/chendefine/dsh-web-fetch-playwright)

## Features

- **Real browser rendering** — loads the page the way a user sees it, so client-side rendered (SPA) content is captured, not just the raw HTML.
- **Denoise pipeline** — Mozilla Readability extracts the article, DOMPurify removes layout/noise tags (nav, sidebar, footer, ads, forms), and Turndown with the GFM plugin converts to Markdown with the same style options as the shipped `tool-web` renderer.
- **Two backends** — launch a local Playwright browser, or drive an already-running browser over its DevTools Protocol (CDP) endpoint.
- **Browser resolution** — a configured path, a `playwright` CLI on `$PATH`, or the bundled `playwright-core`; CDP needs no local browser at all.
- **Isolated or profile sessions (CDP)** — every fetch is scoped to exactly one tab. Local launches close their browser per fetch; the CDP backend keeps **one shared connection** to the remote browser and each fetch opens a tab inside it, closed when done. By default that tab lives in the remote browser's **real profile** (its cookies, localStorage, and persistent logins apply — like `playwright-cli open`); unchecking *Share the browser context* switches to a throwaway isolated context per fetch.
- **Live configuration** — a settings card (设置 → 插件 → 插件配置) edits the backend, context mode, denoise toggle, and concurrency; changes apply to the next fetch without a restart.
- **Budget-aware** — per-fetch deadline (45s); concurrency is backend-priced (`maxConcurrency`, default 4 local browsers / **50 CDP tabs**; queued fetches fail fast with a retry hint after 20s instead of hanging); image/font/media subrequests aborted; body capped at 100k chars.

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

![Playwright 网页爬取 plugin configuration card](./playwright-plugin-config.png)

| Field | Default | Description |
| --- | --- | --- |
| `backend` | `local` | Radio: *Local Playwright* or *Remote CDP endpoint*, each with its own nested input. |
| `playwrightPath` | (blank) | Local backend: path to a `playwright` executable or a Chromium-family browser binary. Blank = discover on `$PATH`, then fall back to the bundled `playwright-core`. |
| `cdpEndpoint` | `127.0.0.1:9222` | Remote backend: `host:port`, `http(s)://…` or `ws(s)://…`. |
| `shareBrowserContext` | `true` | CDP backend only. **Checked (profile mode)**: each fetch is a tab in the remote browser's default context — its real profile — so cookies/localStorage are shared and its persistent logins apply; only the tab closes when the fetch ends. **Unchecked (isolated mode)**: a fresh incognito-like context per fetch, nothing shared. Local backend ignores this field. |
| `denoise` | `true` | Run the denoise pipeline; off returns the full rendered HTML for the tool layer to convert. |
| `maxConcurrency` | *(auto)* | How many fetches may render at once (1–200). Blank = backend default: **4** for local (each slot launches a browser) / **50** for CDP (each slot is just a tab in the already-running remote browser). Beyond the limit, fetches wait briefly; if no slot frees within 20s they fail with `WEB_FETCH_TIMEOUT` and a hint to retry or raise this setting, rather than hanging until the tool budget aborts. |

Local backend resolution order:

1. The configured path (auto-detected as Playwright CLI or browser binary).
2. A `playwright` executable on `$PATH` (its package knows that installation's browser registry).
3. The bundled `playwright-core` — requires `PLAYWRIGHT_BROWSERS_PATH` or browsers in the default cache; otherwise the error suggests `playwright install chromium`.

CDP mode needs no local browser: the provider holds **one shared connection** for its lifetime (reconnecting automatically if it drops, and reconnecting to the new endpoint when the setting changes), and every fetch leases a tab in the remote browser that closes when the fetch completes. Concurrency therefore counts tabs, which is why the CDP default is high (50). Unloading the plugin drops the shared connection (the remote browser itself is never closed).

### The CDP context modes (share the browser's profile or not)

With *Share the browser context* **checked** (default, profile mode), each fetch is a tab in the remote browser's default context — the real profile. Cookies and localStorage come from and are written back to that profile, so sites the browser is logged into are fetched logged-in, exactly like a tab you open by hand. The shared context is never closed; resource filtering and popup guards attach to the fetch's tab only, so your other tabs are untouched. With it **unchecked** (isolated mode), every fetch gets a fresh incognito-like context — anonymous reads, nothing persists.

**Profile-mode risk notes** — it upgrades `web_fetch` from "anonymous read" to "acts as the browser's logged-in user":

- A fetched page that talks the agent into a GET-style state-changing URL (logout, settings change, API call) will send it with your session cookies.
- Concurrent fetches to the same site share one cookie jar; one fetch's logout or `Set-Cookie` affects the others.
- Output starts depending on the browser's history (A/B buckets, language preferences). The remote profile also keeps accumulating site data; the plugin never cleans it.

Persistent logins require a persistent user-data-dir. Headful (recommended — log in by hand once):

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-dsh-profile"
```

Headless server (pre-seed logins in a headful environment first): `chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/data/chrome-dsh-profile`. Do **not** add `--incognito` or a throwaway user-data-dir — either defeats profile mode. Design notes and verified playwright-core facts live in [`docs/context-mode-profile.md`](./docs/context-mode-profile.md).

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

Same stance as the built-in HTTP provider: **no SSRF / private-network protection is implemented** — anything the browser can reach, this provider can fetch. The CDP endpoint is configured from the settings page with no loopback restriction, so only expose the settings page to trusted environments. Fetched pages are rendered locally; no data is sent anywhere beyond the target page itself — but note that in profile mode the requests (and any state changes a malicious page tricks the agent into) carry the remote browser's logged-in sessions (see the risk notes above).

## License

[MIT](./LICENSE) © 2026 chendefine
