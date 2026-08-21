# dsh-web-fetch-playwright

[English](./README.md) · [npm](https://www.npmjs.com/package/dsh-web-fetch-playwright) · [GitHub](https://github.com/chendefine/dsh-web-fetch-playwright)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）双端插件：为内置 `web_fetch` 工具提供 **Playwright/CDP 后端**——用真实浏览器渲染网页，经 **Readability + DOMPurify + Turndown + GFM** 降噪（清洗导航栏、侧边栏、页脚、贴片广告）后输出 Markdown。

![npm](https://img.shields.io/npm/v/dsh-web-fetch-playwright) ![license](https://img.shields.io/npm/l/dsh-web-fetch-playwright) ![node](https://img.shields.io/node/v/dsh-web-fetch-playwright) ![CI](https://img.shields.io/github/actions/workflow/status/chendefine/dsh-web-fetch-playwright/ci.yml) ![stars](https://img.shields.io/github/stars/chendefine/dsh-web-fetch-playwright)

## 特性

- **真实浏览器渲染** —— 以用户视角加载页面，SPA 客户端渲染内容也能抓到，而非只有原始 HTML。
- **降噪管线** —— Mozilla Readability 提取正文，DOMPurify 移除布局/噪音标签（导航、侧边栏、页脚、广告、表单），Turndown + GFM 插件按与内置 `tool-web` 渲染器一致的风格转成 Markdown。
- **两种后端** —— 本地启动 Playwright 浏览器，或通过 DevTools 协议（CDP）驱动一个已在运行的浏览器。
- **浏览器解析** —— 配置路径 → `$PATH` 上的 `playwright` CLI → 插件自带的 `playwright-core`；CDP 模式完全不需要本地浏览器。
- **隔离会话** —— 每次抓取使用独立 browser context；本地启动用完即关，CDP 连接仅断开，浏览器不会比调用它的一次抓取活得更久。
- **热配置** —— 「设置 → 插件 → 插件配置」卡片可随时切换后端与降噪开关，改动对下一次抓取即时生效，无需重启。
- **预算控制** —— 单次抓取 45s 超时、并发上限 2 个浏览器、拦截图片/字体/媒体子请求、返回体 10 万字符封顶。

## 工作原理

| 半端 | 位置 | 职责 |
| --- | --- | --- |
| 宿主（服务端） | `src/` | 向 `ctx.web` 注册 fetch provider（id `playwright`）；`cordis.patch.yml` 把 web seam 的 `fetchProvider` 固定为本插件，并启用 `web_fetch` 工具（60s 预算）。 |
| 浏览器（客户端） | `src/client/` | 注册 *Playwright 网页爬取* 配置卡片，通过 settings 服务把改动热写入 `$DSH_HOME/settings.yaml`。 |

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = playwright
        ├─ local: 解析（路径 → $PATH → 内置 playwright-core）→ chromium.launch
        ├─ cdp:   connectOverCDP(endpoint)
        ├─ page.goto → 等待稳定（networkidle，尽力而为）→ page.content()
        ├─ 降噪：jsdom → Readability → DOMPurify → Turndown(GFM)
        └─ Markdown（关闭降噪时返回原始 HTML）
```

## 环境要求

- DSH web profile（`dsh web`），Node.js ≥ 20。
- **本地**后端：装有 Chromium 的 Playwright、Chromium 系浏览器可执行文件，或默认缓存里有浏览器的 `playwright-core`。
- **CDP** 后端：任意已带 `--remote-debugging-port` 启动的浏览器（如 `chromium --headless --remote-debugging-port=9222`）。

## 安装

从 npm registry 安装（预构建产物，无需构建授权）：

```sh
dsh plugin --profile web add dsh-web-fetch-playwright
```

从 GitHub 仓库安装（源码型，pnpm 会在安装时跑 `prepare` 构建；若 pnpm 拦截构建脚本，请在 `profiles/web/pnpm-workspace.yaml` 中放行该包）：

```sh
dsh plugin --profile web add github:chendefine/dsh-web-fetch-playwright
```

或通过 DSH 插件市场（设置 → DSH插件市场）一键安装——本仓库带 `dsh-plugin` topic，会被自动收录。

bundle 插件加入 profile 层栈后需**重启 `dsh web`** 生效；卸载用 `dsh plugin --profile web remove dsh-web-fetch-playwright` 后重启。

## 配置项

设置卡片（设置 → 插件 → 插件配置 → *Playwright 网页爬取*）实时编辑 `web-fetch-playwright` 设置段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `local` | radio：本地 Playwright / 远端 CDP 地址，每个选项内嵌各自的填空。 |
| `playwrightPath` | 空 | 本地后端：`playwright` 可执行文件或 Chromium 系浏览器二进制路径；留空按 `$PATH` 查找，再回退到内置 `playwright-core`。 |
| `cdpEndpoint` | `127.0.0.1:9222` | 远端后端：`host:port`、`http(s)://…` 或 `ws(s)://…`。 |
| `denoise` | `true` | 是否启用降噪；关闭时返回整页渲染 HTML，交由工具层转换。 |

本地后端解析顺序：

1. 配置的路径（自动判别 Playwright CLI / 浏览器二进制）；
2. `$PATH` 上的 `playwright`（其包自带该安装的浏览器注册表）；
3. 插件内置的 `playwright-core`——需要 `PLAYWRIGHT_BROWSERS_PATH` 或默认缓存里有浏览器，否则报错会提示 `playwright install chromium`。

CDP 模式不需要本地浏览器：每次抓取独立连接并使用隔离 context，不污染已有浏览器会话。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run（无浏览器时浏览器集成用例自动跳过）
pnpm build       # tsc 声明 + tsdown（宿主 ESM + 客户端 module-registration bundle）
```

仓库结构：

```
src/
├── index.ts               # 宿主入口：注册 provider 与设置段
├── config.ts              # schemastery schema、CDP 端点归一化
├── provider.ts            # WebFetchProvider：导航、超时、信号量、截断
├── markdown.ts            # 降噪管线（Readability + DOMPurify + Turndown/GFM）
├── playwright-resolve.ts  # 本地后端发现（路径 / $PATH / 内置 core）
├── types.ts               # Playwright 结构化类型（运行时模块动态发现）
└── client/                # 浏览器半端：设置卡片、表单模型、多语言
tests/                     # 单元 + provider + 浏览器集成（可自跳过）
```

开发与发布流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全模型与漏洞报告见 [SECURITY.md](./SECURITY.md)。

## 安全边界

与内置 HTTP provider 同立场：**未实现 SSRF/私网防护**——浏览器能访问的目标，本 provider 就能抓。CDP 地址由设置页配置，不做回环限制，请在可信环境暴露设置页。抓取仅在本地渲染，除目标页面自身外不会向任何地方发送数据。

## 许可证

[MIT](./LICENSE) © 2026 chendefine
