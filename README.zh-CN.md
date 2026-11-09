# dsh-web-fetch-playwright

[English](./README.md) · [npm](https://www.npmjs.com/package/dsh-web-fetch-playwright) · [GitHub](https://github.com/chendefine/dsh-web-fetch-playwright)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）双端插件：为内置 `web_fetch` 工具提供 **Playwright/CDP 后端**——用真实浏览器渲染网页，经 **Readability + DOMPurify + Turndown + GFM** 降噪（清洗导航栏、侧边栏、页脚、贴片广告）后输出 Markdown。

![npm](https://img.shields.io/npm/v/dsh-web-fetch-playwright) ![license](https://img.shields.io/npm/l/dsh-web-fetch-playwright) ![node](https://img.shields.io/node/v/dsh-web-fetch-playwright) ![CI](https://img.shields.io/github/actions/workflow/status/chendefine/dsh-web-fetch-playwright/ci.yml) ![stars](https://img.shields.io/github/stars/chendefine/dsh-web-fetch-playwright)

## 特性

- **真实浏览器渲染** —— 以用户视角加载页面，SPA 客户端渲染内容也能抓到，而非只有原始 HTML。
- **降噪管线** —— Mozilla Readability 提取正文，DOMPurify 移除布局/噪音标签（导航、侧边栏、页脚、广告、表单），Turndown + GFM 插件按与内置 `tool-web` 渲染器一致的风格转成 Markdown。内联 `data:` 图片（Docusaurus 等构建工具会把截图以 base64 内嵌进 HTML）会被替换为带大小的占位符，如 `![alt](data:image/png;base64,...8.9KB)`，避免 base64 字符流刷屏。
- **两种后端** —— 本地启动 Playwright 浏览器，或通过 DevTools 协议（CDP）驱动一个已在运行的浏览器。
- **浏览器解析** —— 配置路径 → `$PATH` 上的 `playwright` CLI → 插件自带的 `playwright-core`；CDP 模式完全不需要本地浏览器。
- **共享 profile 或复用隔离上下文（CDP）** —— 每次抓取通过共享 CDP 连接创建自己的标签页，用完即关。默认复用浏览器已有默认 context 与登录态（`connectOverCDP` → `browser.contexts()[0]`，类似关闭隔离后的 CLI CDP attach，而不是 `playwright-cli open`）。会话隔离按需创建独立的内存 context，仅在同一会话的抓取或其他标签页仍在使用时复用；全局隔离则在同一插件实例内跨会话保留并复用一个固定的隔离 context。本地后端仍每次抓取启动并关闭浏览器。
- **热配置** —— 插件页（侧边栏 → 插件 → *dsh-web-fetch-playwright*，dsh ≥ 0.1.7）在插件自己的包页面直接展示完整表单（也可通过该行的「配置」入口进入同一表单）；可随时切换后端、上下文模式、降噪开关与并发数，提交的改动对下一次抓取即时生效，无需重启。
- **预算控制** —— 单次抓取 45s 超时；并发按后端定价（`maxConcurrency`，默认本地 4 个浏览器 / **CDP 50 个标签页**；排队的抓取等不到空位会在 20s 内尽快报错并提示重试，而不是一直挂到被工具层中止）；拦截图片/字体/媒体子请求；返回体 10 万字符封顶。
- **Cloudflare 挑战有界等待** —— 导航落到验证中间页（"Just a moment…" 及其多语言同族，通过官方 `cf-mitigated: challenge` 响应头 + 结构性页面标记识别）时，抓取保持**同一标签页与上下文**，等待浏览器自行通过验证：跟踪*最后一次*主 frame 响应（真实页面随后重载进来），并轮询活 DOM 以捕获 SPA 式清除。有界且可配置（`challengeWaitMs`，默认 15s；`0` 恢复旧版首响应行为），附带同标签页有界重试（`challengeRetries`，默认 1）。预算耗尽时以独立的 `WEB_FETCH_CHALLENGE` 错误码明确失败，而不是把中间页当正文返回。全程不点击、不注入验证码答案、不伪造浏览器状态、不导出或复制 cookie。

## 工作原理

| 半端 | 位置 | 职责 |
| --- | --- | --- |
| 宿主（服务端） | `src/` | 向 `ctx.web` 注册 fetch provider（id `playwright`）；`cordis.patch.yml` 把 web seam 的 `fetchProvider` 固定为本插件，并启用 `web_fetch` 工具（60s 预算）。 |
| 浏览器（客户端） | `src/client/` | 在插件页的 `plugins.bundle.config` / `plugins.row.config` 席位注册 *Playwright 网页爬取* 配置表单，通过共享的设置表单服务提交改动。 |

```
web_fetch (tool-web)
   └─ ctx.web.fetchProvider = playwright
        ├─ local: 解析（路径 → $PATH → 内置 playwright-core）→ chromium.launch
        ├─ cdp:   connectOverCDP(endpoint)
        ├─ page.goto → 等待稳定（networkidle，尽力而为）→ 在活 DOM 中剥离脚本子树 → page.content()
        ├─ 降噪：jsdom → 内联 data: 图片改占位符 → Readability → DOMPurify → Turndown(GFM)
        └─ Markdown（关闭降噪时返回原始 HTML）
```

**非 2xx 状态码是结果而非错误** —— 这是 web seam 的契约（`@deepseek-ai/dsh-web`）：抓取到的 404/418/500 会连同状态码一起正常返回，与 `dsh-web-fetch-http` 的行为一致。但对*仅有状态*的响应 Chromium 会把事情搞砸 —— 空 body 的错误状态（httpbin 的 `/status/404`）会让整个导航以 `net::ERR_HTTP_RESPONSE_CODE_FAILURE` 失败，204/205 则因无可渲染内容被中止（`net::ERR_ABORTED`）。因此 provider 在每次抓取中都跟踪最后一个主框架响应（该响应先于 Chromium 判定导航失败到达），并把这类失败恢复成带状态码的正常结果，`web_fetch` 会报告 `Fetched … (HTTP 404)` 而不是抛出 `WEB_PROVIDER_ERROR`。同样的恢复也覆盖*下载型*响应 —— 带 `Content-Disposition: attachment` 的 body（publish.twitter.com 的 oembed 端点——agent 读取推文常用的替代 URL——返回的 JSON 正是如此）永远不会被提交为文档：`goto` 以 `Download is starting` 拒绝，且 body 已从网络栈中流失，provider 因此通过页面的 API request context 重新拉取并返回可解码内容；不可解码的下载（PDF、ZIP）仍以 `WEB_UNSUPPORTED_CONTENT_TYPE` 失败。若恢复出的响应本身来自 Cloudflare 挑战边缘，仍以 `WEB_FETCH_CHALLENGE` 失败；传输错误与取消也依旧按错误处理。

**回读文档前，先在活 DOM 中剥离非内容脚本子树 —— 构造上即输出中性。** 降噪管线（以及关闭降噪时工具层自己的渲染器）会用 jsdom 重新解析 `page.content()`，而脚本的*文本内容*是这条往返链路中唯一无法信任的东西：页面自身的运行时 JS 可能把内嵌 `</script>` 的文本写回某个数据脚本的 textContent —— 实测于 techcommunity.microsoft.com（Khoros/Aurora 平台），其客户端把整个 Apollo 缓存经 `JSON.stringify` 写回 `script#__NEXT_DATA__`，把线上响应里 712 处 `\u003c` 转义还原成了裸 `<` —— 而浏览器序列化脚本文本时原样输出，于是这份扁平化的 HTML 字符串会在*第一个*内嵌结束标签处终止脚本，把余下约 270KB 的 JSON *当作标记语言*解析。解析出的幽灵元素（`<id>` 之类的未知标签、塞满 CSS 与 i18n 字符串的锚点）恰好是 Readability 评分器眼里的"正文质量"（实测 126 分对真实正文的 45 分），于是抓取 RDP 10 AVC/H.264 一文时返回的是 CSS 规则和 `CachedAsset` 字符串而不是文章本体。事后再对字符串做补丁无法消除这种歧义 —— 只有浏览器自己的解析持有文档的真实结构 —— 因此普通的 `script` 与 `template` 子树在 `page.content()` 之前先在活页面里剥掉（`page.evaluate`，尽力而为）。这不会改变管线以往的任何输出：Readability 本就在抽取与评分前删除 script/noscript 节点，DOMPurify 的白名单本就丢弃 script，工具层渲染器也整体移除 SCRIPT/TEMPLATE —— 在真实页面语料（Wikipedia、MDN、Hacker News、坏例页 wire 版，加上 noscript/JSON-LD/template 边界用例）上的差分 A/B **每一页都字节级一致**。两个刻意的保留让间接消费方也不受损：`script[type="application/ld+json"]` 只做*消险*而非删除（`</` 改写为 `<\/` —— 仍是合法 JSON，Readability 的元数据读取解析到同一对象，文章标题保持无站点后缀的干净形态，如 "Remote Desktop Protocol" 而非 "… - Wikipedia"）；`noscript` 完整保留，因为 Readability 的 `_unwrapNoscriptImages` 会从懒加载的 `<noscript><img …>` 包裹中抢救出真实图片。该剥离在关闭降噪时同样生效，让返回给工具层渲染器的原始 HTML 也是序列化安全的，并把管线要解析的体积压缩约 70%（以该坏例页计）。

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

插件页（侧边栏 → 插件）从列表一跳即达：*dsh-web-fetch-playwright* 卡片落在包页面，完整表单位于其描述与行列表之间；该行的「配置」入口在插件自己的标题下打开同一表单。表单实时编辑 `web-fetch-playwright` 设置段（由插件条目的 `Config` schema 派生）：

![Playwright 网页爬取 plugin configuration card](./playwright-plugin-config.png)

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `local` | radio：本地 Playwright / 远端 CDP 地址，每个选项内嵌各自的填空。 |
| `playwrightPath` | 空 | 本地后端：`playwright` 可执行文件或 Chromium 系浏览器二进制路径；留空按 `$PATH` 查找，再回退到内置 `playwright-core`。 |
| `cdpEndpoint` | `127.0.0.1:9222` | 远端后端：`host:port`、`http(s)://…` 或 `ws(s)://…`。 |
| `shareBrowserContext` | `true` | 仅 CDP：单选共享 / 隔离。`true` 复用远端默认 context 与登录态；`false` 使用独立 context，生命周期由下方范围决定。本地后端忽略。 |
| `contextIsolationScope` | `global` | 仅 CDP 隔离模式：`session` 按 DSH 会话按需创建 context，无活动/待处理抓取且无打开的标签页后关闭（下次抓取使用全新状态）；`global` 在同一插件实例内跨DSH会话复用一个固定的隔离上下文。 |
| `denoise` | `true` | 是否启用降噪；关闭时返回整页渲染 HTML，交由工具层转换。 |
| `maxConcurrency` | *（自动）* | 同时渲染的页面上限（1–200）。留空按后端取默认：本地 **4**（每个槽位启动一个浏览器）/ CDP **50**（远端浏览器已就位，每个槽位只是一个标签页）。超出的请求短暂排队；20s 内等不到空位则以 `WEB_FETCH_TIMEOUT` 尽快失败并提示重试或调大该值，而不是一直挂起直到工具层预算中止。 |
| `challengeWaitMs` | `15000` | Cloudflare 挑战的**有界**自然等待上限（毫秒，0–60000），在同一标签页内等待浏览器自行通过验证。`0` 关闭整条挑战处理链路——直接返回首次响应（0.2.5 之前的旧行为）。 |
| `challengeRetries` | `1` | 一个等待窗口耗尽后的**同标签页**重新导航次数（0–3）；浏览器已拿到的通关 cookie 留在上下文里供重试使用。总耗时始终受 45s 单次抓取预算约束。 |

本地后端解析顺序：

1. 配置的路径（自动判别 Playwright CLI / 浏览器二进制）；
2. `$PATH` 上的 `playwright`（其包自带该安装的浏览器注册表）；
3. 插件内置的 `playwright-core`——需要 `PLAYWRIGHT_BROWSERS_PATH` 或默认缓存里有浏览器，否则报错会提示 `playwright install chromium`。

> **Windows 说明** —— `$PATH` 已按平台分隔符（`;`）扫描，但 npm/pnpm 全局安装暴露的 `playwright` 是 `.cmd`/`.ps1` 垫片，从垫片位置向上找不到包根，自动发现可能仍落在第 3 步（内置 core）。要使用指定安装的浏览器注册表，请把 `playwrightPath` 显式指向 `playwright` 包目录或浏览器二进制。

CDP 模式不需要本地浏览器：插件在生命周期内对远端浏览器保持**一条共享连接**（连接断开自动重连，地址改动后自动换连），每次抓取只租用远端浏览器里的一个标签页，抓取结束即关闭。因此并发数按"标签页"计，默认也更高（50）。插件卸载时断开共享连接（绝不会关闭远端浏览器本身）。

### CDP 上下文模式（是否共享浏览器 profile）

选择**共享浏览器上下文**（默认）时，在远端浏览器已有的默认 context 内开标签页，双向共享 cookie / localStorage 并复用登录态；插件永不关闭这个默认 context。资源过滤与弹窗守卫只作用于本次抓取自己的标签页。

选择**隔离浏览器上下文**后，再选择复用范围：

- **按 DSH 会话隔离**：按 DSH 会话 ID 按需创建独立 CDP 连接、独立 context 和专属浏览器窗口。即便 CDP 网关把每条连接的第一个 context 映射为独立 Chromium，不同会话也不会落入同一连接下的嵌套 context；空闲回收时连同该会话的连接一起释放。同一会话的并发抓取在自己的 context/窗口内各开一个标签页，每次只关闭自己的标签页。创建 context、创建标签页，以及“关标签页→检查是否为空→关 context”都在同一把按会话键划分的 FIFO 锁内执行；网页抓取仍可并发，不同会话互不阻塞。没有抓取标签页或其他打开的标签页后关闭 context；排队的新建请求须等待关闭完成，再创建新的 context。回收后 cookie / localStorage 重置。实现校验真实 CDP context ID 和 window ID，按 target ID 匹配新页面；端点不支持这些隔离保证或调用缺少会话 ID 时明确失败，绝不回退到默认 profile。
- **跨DSH会话全局复用**（默认）：本插件实例内所有 DSH 会话复用一个固定的隔离 context。

插件自行创建隔离 context，不查找其他工具创建的 context。全局隔离仍在抓取之间保留 context：抓取结束仅关自己的标签页，因此后续抓取可沿用 cookie / localStorage。会话隔离则按上述规则，在没有活动/待处理抓取且没有打开的标签页后释放 context。这是内存复用，不保证浏览器或插件重启后保留；上下文配置变更会退役旧 context，卸载、断连或连接替换也会清理。全局隔离仅与浏览器 profile 隔离，**不隔离同一插件实例内的其他 DSH 会话**。

如果其他 CDP 客户端删除了插件拥有的隔离 context，Chromium 不一定触发 Playwright 的 context `close` 事件。遇到明确的 `Target.createTarget` “Failed to find browser context with id …” 错误时，插件只让对应缓存失效，并在新的 context 中最多重试一次开标签页。并发请求复用同一个替代 context；被删除 context 的 cookie / localStorage 不会恢复。其他 context 与默认 profile 不受影响。该恢复机制不会重试普通页面错误、重放网页导航或回退到默认 profile。

**profile 模式风险须知** —— 它把 `web_fetch` 从"匿名读网页"升级为"以浏览器登录身份行动"：

- 被抓取的恶意页面若诱导 agent 请求 GET 型状态变更 URL（登出、改设置、API 操作），请求会自动携带会话 cookie。
- 同一站点的并发抓取共享一个 cookie jar，一方的登出 / `Set-Cookie` 会影响另一方。
- 输出开始依赖浏览器历史（A/B 分桶、语言偏好）；远端 profile 的站点数据只增不减，插件不做清理。

登录态持久的前提是 user-data-dir 持久化。有头（推荐，手动登录一次）：

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-dsh-profile"
```

无头服务器（先在有头环境预置登录态）：`chromium --headless=new --remote-debugging-port=9222 --user-data-dir=/data/chrome-dsh-profile`。**不要**叠加 `--incognito` 或一次性 user-data-dir——都会让 profile 模式失效。设计依据与已核实的 playwright-core 源码事实见 [`docs/context-mode-profile.md`](./docs/context-mode-profile.md)。

### Cloudflare 挑战处理（有界自然等待）

部分严格站点会在返回真实页面前先给一个 Cloudflare 验证中间页。真实浏览器通常几秒内就能**自行**通过验证；但只看第一次响应的抓取会把中间页当成正文返回（0.2.5 之前的旧行为；把 `challengeWaitMs` 设为 `0` 可随时复现，或在仓库检出、执行 `pnpm build` 后运行 `node scripts/challenge-demo.mjs` 看本地模拟站点的前后对比、`node scripts/challenge-online.mjs <url>` 对真实站点做在线对比）。

开启等待（默认）后的流程：

1. **识别** —— 响应带 `cf-mitigated: challenge`（Cloudflare 官方文档注明所有挑战页类型都带此头），或 403/503 且 `server: cloudflare` 的 HTML 文档，或本地化的中间页本身（"Just a moment…" / "请稍候…" / "Минутку…" 等 title 家族，以及结构性标记：挑战运行时的 `<script src>`、`#challenge-*` 元素、`cf-chl-widget-` 框架、`window._cf_chl_opt`）。内容级标记只是**兜底层**，且仅对"挑战兼容"的响应（403/429/503 或来自 Cloudflare 边缘——`server: cloudflare` / `cf-ray`）运行——因为中间页从不会以普通 200 返回，所以正文里引用了挑战文案的普通文章绝不可能被误判。两处收紧让这个承诺真正成立：挑战平台脚本只读真实的 `<script src>` 属性（正文、以及转义后的代码示例里引用的路径一律忽略），并且**正面**匹配运行时挂载点 `/cdn-cgi/challenge-platform/h/[b|g]/orchestrate/`。该前缀下 Cloudflare 注入的其余脚本——Bot Management 的 JavaScript Detections（`scripts/jsd/`、`h/[b|g]/scripts/jsd/<hash>/`、`h/[b|g]/jsd/r/`）与 Precursor（`scripts/precursor/`）——都是会注入受保护站点**每一个正常页面**的被动探测脚本（如 openrouter.ai、nodeseek.com），永远不算挑战信号。硬封锁页（"Sorry, you have been blocked"）单独分类并立即失败——等待无法解除。
2. **同标签页、同上下文的有界等待** —— 每 500ms 轮询活 DOM，等浏览器跑完自己的验证；同时跟踪**最后一次主 frame 导航响应**，所以重载进来的真实文档的状态码和响应头才是最终上报的。SPA 式清除（无导航、纯内容替换）由同一个 DOM 探测捕获。
3. **有界重试** —— 窗口耗尽后，同一标签页默认再导航一次（`challengeRetries`），上下文里已有的通关 cookie 继续生效。
4. **明确失败** —— 返回独立的 `WEB_FETCH_CHALLENGE` 错误码（web seam 的 `code` 是开放字符串，允许 provider 专属码），消息中写明站点、等待预算与最后一次挑战响应的状态。

安全边界（刻意为之）：不点击 Turnstile、不解验证码、不注入 token、不伪装指纹/UA、不轮换代理、不导出 cookie——CDP 隔离模式下通关态保留在对应会话 / 全局 context 中，直到该 context 被清理（本地 context 仍随每次抓取结束）；profile 模式下它留在远端浏览器自己的 profile 里，插件从不复制或清理。等待始终受 `challengeWaitMs` 与 45s 单次抓取预算双重约束，永不无限阻塞。

## 开发

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run（无浏览器时浏览器集成用例自动跳过）
pnpm build       # tsc 声明 + tsdown（宿主 ESM + 客户端 module-registration bundle）
```

用真实 Chromium 执行外部删除 context 的回归测试（测试自行启动浏览器和本地站点，不连接配置中的用户浏览器）：

```sh
PLAYWRIGHT_TEST_EXECUTABLE_PATH=/path/to/chromium pnpm exec vitest run tests/cdp-recovery.browser.spec.ts
```

未指定路径时使用 Playwright 默认浏览器；默认二进制不存在会明确报告跳过。显式路径错误或启动失败则使测试失败。

仓库结构：

```
src/
├── index.ts               # 宿主入口：注册 fetch provider（设置段由插件的 Config schema 派生）
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

与内置 HTTP provider 同立场：**未实现 SSRF/私网防护**——浏览器能访问的目标，本 provider 就能抓。CDP 地址由设置页配置，不做回环限制，请在可信环境暴露设置页。抓取仅在本地渲染，除目标页面自身外不会向任何地方发送数据——但 profile 模式下请求（以及恶意页面诱导 agent 触发的状态变更）会携带远端浏览器的登录会话，见上文风险须知。

## 许可证

[MIT](./LICENSE) © 2026 chendefine
