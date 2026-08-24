# contextMode: 'profile' 开发指引 —— 让 CDP 后端复用远端浏览器的持久登录态

> 状态:**已实现(插件 v0.2.2)**。本文档是当时的实施依据,包含已验证的 playwright-core 源码事实、
> 设计不变量、逐文件改动清单(附代码草稿)、测试计划与验收清单;实现与其有两处按最新需求确定的偏差:
> ① 用户界面用 **checkbox**(配置字段 `shareBrowserContext: boolean`,默认 `true` 即共享)而非 4.5 节的
> radioField;② **默认值为共享(profile)模式**而非 4.1 节的 `isolated`。其余设计(事实 F1–F8、
> 不变量 I1–I7、池/Provider 改法)按本文实现。
>
> 适用版本:插件 v0.2.1,捆绑 `playwright-core` **1.62.1**(证据行号以此版本 bundle 为准,
> 升级后行号会漂移,按附录 C 的符号搜索方式定位)。

---

## 1. 背景与动机

### 1.1 现状行为

CDP 后端(`backend: 'cdp'`)当前的 fetch 生命周期是:

```
CdpConnectionPool.acquire()
  └─ browser.newContext()          ← 每次 fetch 新建隔离 context(≈隐身窗口)
       └─ context.newPage() → 渲染 → 返回结果
  └─ release() → context.close()   ← cookie/localStorage 全部销毁
```

`browser.newContext()` 在 CDP 上走 `Target.createBrowserContext`,官方文档明确:
"It won't share cookies/cache with other browser contexts"。因此**远端浏览器里已登录的
站点会话对新 fetch 完全不可见**,需要登录的页面取回来的是登录墙/匿名视图。

### 1.2 目标行为(需求原文的精确化)

1. 使用远端浏览器(`--remote-debugging-port` 启动、带持久 user-data-dir)里**已有的登录态**;
2. 每次 fetch 是**一个独立 tab**:开启 → 渲染 → 自动关闭,生命周期完整且自包含;
3. tab 之间操作互不干扰(DOM/JS/导航互相隔离);
4. **共享 cookie 与 localStorage 是预期行为**(它们来自并写回真实 profile)。

### 1.3 方案一句话

新增 opt-in 配置 `contextMode: 'isolated' | 'profile'`(仅 CDP 后端生效,默认
`isolated` 保持现状)。`profile` 模式下,fetch 生命周期从 **context 级收缩到 page 级**:
共享连接不变,取远端浏览器的**默认 context**(真实 profile,永不关闭),每次 fetch 在其中
开一个 tab,结束时只关这个 tab。

---

## 2. 已验证的 playwright-core 事实(实现依据)

以下每一条都在插件的 `node_modules/playwright-core`(1.62.1)里核实过。附录 C 有证据索引。

### F1 `connectOverCDP` 天然把远端真实 profile 挂为默认 context

`_connectOverCDPImpl` 无条件构造 persistent 选项:

```js
// lib/coreBundle.js ~42855
const persistent = { noDefaultViewport: true, ...options.noDefaults ? {...} : {} };
```

`CRBrowser.connect` 因 `options.persistent` 存在而创建默认 context:

```js
// ~38110
if (!options.persistent) { /* 仅 autoAttach 后返回 */ }
browser._defaultContext = new CRBrowserContext(browser, void 0, options.persistent);
```

**意义**:什么都不用做,连接建立后默认 context 就在那里,装着真实 profile 的
cookie/storage/缓存。

### F2 官方文档推荐入口就是 `browser.contexts()[0]`

`types/types.d.ts`(16825–16851)对 `connectOverCDP` 的三条重载都写着:

> The default browser context is accessible via `browser.contexts()`.
> ```js
> const browser = await playwright.chromium.connectOverCDP('http://localhost:9222');
> const defaultContext = browser.contexts()[0];
> ```

### F3 `contexts()[0]` 恒为默认 context(顺序有保证)

`BrowserDispatcher` 构造时按固定顺序向客户端派发 context 事件:

```js
// ~55056
if (browser._defaultContext)
  this._dispatchEvent("context", { context: BrowserContextDispatcher.from(this, browser._defaultContext) });  // 默认 context 永远第一个
for (const context2 of browser.contexts())
  this._dispatchEvent("context", { context: ... });  // 之后才是本连接 newContext() 创建的
```

外部(非本 Playwright 连接)创建的 CDP context **不会**出现在客户端 `contexts()` 里
(服务端 `_contexts` 只在 `doCreateNewContext` 里增加条目)。

**意义**:`browser.contexts()[0]` 取默认 context 是确定性操作,无需启发式挑选。
仍要防 `contexts()` 缺失(极老的 endpoint),给可诊断错误。

### F4 隔离语义的根因(即现状问题所在)

`browser.newContext()` → `doCreateNewContext` → `Target.createBrowserContext`
(独立 cookie jar/存储)。这是 1.1 的根因,也是 `isolated` 模式继续使用的东西。

### F5 默认 context 里 `newPage()` = 真实 profile 中的真 tab

```js
// CRBrowserContext ~38340
async doCreateNewPage() {
  const { targetId } = await this._browser._session.send("Target.createTarget",
    { url: "about:blank", browserContextId: this._browserContextId });  // 默认 context 此 id 为 void 0
  ...
}
```

tab(CDP target)之间天然隔离 DOM/JS 堆/导航/崩溃;共享的是 context 级的
cookie jar、per-origin localStorage/sessionStorage、HTTP 缓存、service worker —— 与需求
2/3/4 逐条吻合。

### F6 【红线】默认 context 绝不能 close

`CRBrowserContext.doClose()` 对默认 context(`browserContextId` 为空)返回特殊处置:

```js
// ~38493
async doClose(reason) {
  await this.dialogManager.closeBeforeUnloadDialogs();
  if (!this._browserContextId) {
    return "close-browser";           // ← 默认 context 走这条
  }
  ...Target.disposeBrowserContext...
}
```

上层收到后执行整浏览器关闭:

```js
// 服务端 BrowserContext.close ~51600
const disposition = await progress2.race(this.doClose(options.reason));
if (disposition === "close-browser")
  await this._browser.close(progress2, { reason: options.reason });
```

**在 CDP 连接下的实际后果(精确表述,勘误见 2.1)**:`browser.close()` 对
`connectOverCDP` 句柄只是**关传输层断开连接**(`browserProcess.close = doClose →
chromeTransport.closeAndWait()`,不发 CDP `Browser.close` 命令):

```js
// _connectOverCDPInternal ~42830 / _connectOverCDPImpl ~42850
const closeAndWait = async () => await chromeTransport.closeAndWait();
const browserProcess = { close: doClose, kill: doClose };  // 仅断开
```

所以 close 默认 context = **当场断掉共享连接**:该连接上所有并发 fetch 立即以
"Target closed" 失败,池子被迫重连,客户端 Browser 对象作废(必须重连拿新句柄)。
远端浏览器进程与其 profile 会幸存,但这仍是必须杜绝的故障模式 —— profile 模式下
**任何代码路径都不得对默认 context 调用 `close()`**。

### F7 `browser.close()`(CDP)= 仅断开,池子现有行为安全且保持不变

同 F6 的证据:连接对象的 `close()` 只断传输层。`CdpConnectionPool` 现有的
`dispose()` 与 `connectFresh()` 里 `stale?.close()` 都属此类,天然兼容 profile 模式,
**无需改动**。远端浏览器和登录态不受影响。

### F8 CDP 是"lower fidelity"通道,拦截类能力需防御式使用

官方 NOTE(同 F2 位置):"This connection is significantly lower fidelity than the
Playwright protocol connection…"。已知影响:route 拦截可能覆盖不到 service worker
控制的请求。现有 `installResourceFilter` 已 try/catch 降级,搬到 page 级后保持该姿态。

### 2.1 勘误记录

早先讨论中曾说"close 默认 context 会把远端浏览器连同登录会话一起杀掉"。经本节核实,
精确结论是:**杀掉的是 Playwright 连接(连带所有并发 fetch),不是远端浏览器进程**;
登录会话存在远端 profile 磁盘目录里,不受影响。红线结论不变,故障面描述以此为准。

---

## 3. 设计

### 3.1 架构对比

```
isolated(现状,保持不变)          profile(新增)
─────────────────────────         ─────────────────────────
共享 connectOverCDP 连接            共享 connectOverCDP 连接(不变)
 └─ fetch: newContext()             └─ browser.contexts()[0]  ← 默认 context,永生
      └─ newPage → 渲染                  └─ fetch: newPage() → 渲染 → page.close()
      └─ context.close()                 (cookie/storage 全程来自并写回真实 profile)
```

### 3.2 不变量(实现与 review 的检查表)

- **I1** 默认 context 永不被 close(F6)。断开/重连只走 `browser.close()`(F7,安全)。
- **I2** profile 模式的 `release()` / 清理路径只关 page。
- **I3** abort/超时路径在 profile 模式下只关 page —— 关 page 会拒绝该 page 上所有
  pending 操作(abort 语义恰好),且不影响同 context 其他 tab。
- **I4** 资源过滤(`route`)与 popup 守卫安装在 **page 级**。context 级 route 会作用于
  默认 context 里的**所有** tab —— 包括运维人员正在远端浏览器里手工使用的页面。
- **I5** `isolated` 模式行为与现在完全一致(默认值,零回归)。
- **I6** `local` 后端不受影响(`contextMode` 对它无意义,收敛为 `isolated`)。
- **I7** 信号量语义不变:一个槽 = 一个并发 tab(local 后端 = 一个浏览器)。

### 3.3 生命周期与清理路径(改后)

| 事件 | isolated(CDP) | profile(CDP) | local |
|---|---|---|---|
| acquire | `newContext()` + `newPage()` | `contexts()[0]` + `newPage()` | `launch()` + `newContext()` + `newPage()` |
| 正常结束 | 关 page、关 context | **只关 page** | 关 page、关 context、关 browser |
| abort/超时 | 同上(关 context 拒绝 pending) | **只关 page**(拒绝 pending) | 同正常结束 |
| 池 dispose / 换 endpoint | `browser.close()`=断开 | 同左,不变 | 不适用 |
| 连接死亡 | ensure 里重连一次后重试 | 同左(page 随连接死,重连后重新取 `contexts()[0]`) | 不适用 |

注意:profile 句柄**不得跨连接缓存** —— 重连后是新 Browser 对象,必须重新
`contexts()[0]`。在 `acquire()` 内部(拿到 `ensure()` 的当前 browser 之后)取即可,
天然满足。

---

## 4. 逐文件改动清单

### 4.1 `src/config.ts`

新增字段 + 生效逻辑。沿用 `backend` 字段的 union-of-consts 写法(该 schemastery 构建
不暴露 `.enum`,见现有注释):

```ts
/** How the CDP backend scopes a fetch: a throwaway isolated context, or a tab in the remote browser's real profile. */
export type CdpContextMode = 'isolated' | 'profile'

// Config interface 增加:
  /**
   * CDP backend only. 'isolated' (default): fresh incognito-like context per
   * fetch, no shared state. 'profile': each fetch is a tab in the remote
   * browser's default context — cookies/localStorage come from (and are
   * written back to) the real profile, so its persistent logins apply.
   */
  contextMode?: CdpContextMode

// Config schema 增加(default 'isolated' 保证 ResolvedConfig 的 Required 覆盖它):
  contextMode: z.union([z.const('isolated'), z.const('profile')]).default('isolated'),

/**
 * The context mode a fetch actually runs with: profile requires the CDP
 * backend (a local launch has no meaningful shared profile), everything else
 * collapses to isolated.
 */
export function effectiveContextMode(config: Pick<Config, 'backend' | 'contextMode'>): CdpContextMode {
  if (config.backend === 'cdp' && config.contextMode === 'profile') return 'profile'
  return 'isolated'
}
```

顺带在 `src/index.ts` 导出 `effectiveContextMode` 与 `CdpContextMode`(与现有
`normalizeCdpEndpoint` 等导出一致)。

### 4.2 `src/types.ts`

`PlaywrightPage` 已有(`goto/waitForLoadState/url/content/close`),补两个成员;
`PlaywrightBrowser` 补可选 `contexts`(可选是为了不大动现有测试 fake):

```ts
export interface PlaywrightPage {
  // ...现有成员不动...
  /** Resource-filter interception at page level (profile mode shares its context with other tabs). */
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  /** Optional popup guard so window.open cannot strand tabs in the remote browser. */
  on?(event: 'popup', listener: (page: PlaywrightPage) => void): unknown
}

export interface PlaywrightBrowser {
  // ...现有成员不动...
  /** Contexts visible to this connection; [0] is the default context (verified: dispatched first). */
  contexts?(): PlaywrightContext[]
}
```

### 4.3 `src/cdp-pool.ts`(核心)

lease 语义从"context"升级为"context + page",`acquire` 增加 mode 参数。模块头注释
同步更新(现在写着 "each fetch leasing an isolated context…")。

```ts
export type CdpAcquireMode = 'isolated' | 'profile'

export interface CdpLease {
  /** The shared connection — close only what the lease owns, never this. */
  browser: PlaywrightBrowser
  /**
   * The context the page lives in: fetch-owned (isolated) or the remote
   * browser's default context (profile) — NEVER close the latter; closing it
   * tears down the whole shared connection.
   */
  context: PlaywrightContext
  /** The fetch-owned tab; {@link CdpConnectionPool.release} always closes it. */
  page: PlaywrightPage
  /** True when `context` is the remote default context: release must not close it. */
  persistent: boolean
}

async acquire(endpoint: string, timeoutMs: number, mode: CdpAcquireMode = 'isolated'): Promise<CdpLease> {
  const browser = await this.ensure(endpoint, timeoutMs)
  try {
    return await this.openLease(browser, mode)
  } catch (error: unknown) {
    // 与现有语义一致:连接死掉(newContext/newPage 失败)时重连一次再试。
    if (this.isLive(browser)) throw error
    this.drop(browser)
    const fresh = await this.ensure(endpoint, timeoutMs)
    return await this.openLease(fresh, mode)
  }
}

/** Open one lease's page on a live connection. */
private async openLease(browser: PlaywrightBrowser, mode: CdpAcquireMode): Promise<CdpLease> {
  if (mode === 'profile') {
    // [0] is the default context — BrowserDispatcher always dispatches it first,
    // and contexts created outside this connection never appear here.
    const context = browser.contexts?.()[0]
    if (context === undefined) {
      throw new Error('the CDP endpoint exposed no default browser context (profile mode requires a real browser profile)')
    }
    return { browser, context, page: await context.newPage(), persistent: true }
  }
  const context = await browser.newContext()
  return { browser, context, page: await context.newPage(), persistent: false }
}

async release(lease: CdpLease): Promise<void> {
  await lease.page.close().catch(() => {})
  if (!lease.persistent) await lease.context.close().catch(() => {})
}
```

`ensure/connectFresh/watch/drop/dispose` 全部不动(F7:dispose 走的 `browser.close()`
只是断开,兼容默认 context)。

### 4.4 `src/provider.ts`

**(a) `BrowserSession` 扩展**(顺手修复现状的一个隐性依赖:今天 `retrieve()` 开的
page 从不显式 close,靠 context.close 兜底;改动后所有模式统一显式关 page):

```ts
export interface BrowserSession {
  browser: PlaywrightBrowser
  context: PlaywrightContext
  /** The fetch-owned tab this fetch renders in. */
  page: PlaywrightPage
  /** True when `browser` is the CDP pool's shared connection — never closed per fetch. */
  sharedBrowser?: boolean
  /** True when `context` is the remote default context — close only the page. */
  persistent?: boolean
}
```

**(b) `openSession` CDP 分支**:

```ts
if (config.backend === 'cdp') {
  const endpoint = normalizeCdpEndpoint(config.cdpEndpoint)
  const { source } = await resolveCdpBackend()
  try {
    // One shared connection per provider; this fetch leases a tab — in an
    // isolated context, or in the remote profile's default context (profile
    // mode), whose persistent logins then apply.
    const lease = await this.cdpPool.acquire(endpoint, timeout, effectiveContextMode(config))
    await installResourceFilter(lease.page)   // page 级 —— I4
    guardPopups(lease.page)
    return { browser: lease.browser, context: lease.context, page: lease.page, sharedBrowser: true, persistent: lease.persistent }
  } catch (error) { /* 现有 WebError 包装不变 */ }
}
```

**(c) `openSession` local 分支**:launch + newContext 后直接 `const page = await context.newPage()`,
`installResourceFilter(page)`、`guardPopups(page)`,返回值带 `page`(统一三后端形状)。

**(d) `retrieve()`**:删掉 `const page = await session.context.newPage()`,改用
`session.page`。其余(goto/settle/content-type/denoise/cap)不动。

**(e) `closeSession()`**:

```ts
async function closeSession(session: BrowserSession | undefined): Promise<void> {
  if (session === undefined) return
  await closeWithGrace(session.page)
  if (session.persistent !== true) await closeWithGrace(session.context)
  if (session.sharedBrowser !== true) await closeWithGrace(session.browser)
}
```

abort 路径(`onAbort = () => { void closeSession(held) }`)**代码不动** —— 语义由
`persistent` 自动修正为只关 page(I3),关 page 会拒绝该 page 上 pending 的 Playwright
操作,abort 依旧成立,且不再误伤同 context 的其他 tab。

**(f) `installResourceFilter` 移到 page 级**(签名改为结构化最小面,函数体不变):

```ts
async function installResourceFilter(owner: { route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void> }): Promise<void>
```

**(g) 新增 popup 守卫**(防被 fetch 页面 `window.open` 留下孤儿 tab;`page.close()`
不会自动关弹窗):

```ts
/** Close any popup a fetched page spawns so nothing outlives the fetch's tab. */
function guardPopups(page: PlaywrightPage): void {
  try {
    page.on?.('popup', popup => { void popup.close().catch(() => {}) })
  } catch { /* best-effort */ }
}
```

### 4.5 客户端(settings 卡片)

- `src/client/controller.ts`:specs 增加 `radioField('contextMode', ['isolated', 'profile'])`;
  状态投影增加 `contextMode: CardFieldState`(照抄 `backend` 字段的模式)。
- `src/client/card.tsx`:在 CDP 单选项下嵌套渲染 contextMode 单选组(照抄现有
  `cdpEndpoint` 输入框的嵌套与禁用模式,`disabled={disabled || backend !== 'cdp'}`,
  见 87 行附近)。
- `src/client/locales.ts`:新增 key(英文 + 中文),建议文案:
  - `contextModeLabel`: "Context mode" / 「上下文模式」
  - `contextModeIsolated`: "Isolated (per-fetch)" / 「隔离(每次 fetch)」
  - `contextModeIsolatedHint`: "A throwaway incognito-like context per fetch; no shared cookies." / 「每次 fetch 使用一次性隔离上下文,不共享 cookie。」
  - `contextModeProfile`: "Profile (shared logins)" / 「Profile(共享登录态)」
  - `contextModeProfileHint`: "Each fetch is a tab in the remote browser's real profile; its persistent logins apply and pages see your identity." / 「每次 fetch 是远端浏览器真实 profile 里的一个标签页;将使用其持久登录态,页面会看到你的登录身份。」

### 4.6 `package.json` 与文档

- `disclosure.permissions` 增补一条,例如:
  `"network:fetch (profile mode renders the URLs the user requests WITH the remote browser's logged-in sessions)"`,
  并考虑 `retention` 仍为 `"none"`(插件自身不落盘,但远端 profile 会保留站点数据 —— 在 README 说明)。
- 仓库尚无 `README.md` / `README.zh-CN.md`(`package.json.files` 引用了但文件缺失);
  建议随本功能一并创建,写入第 6 节的风险说明与远端浏览器启动指引(附录 A)。

### 4.7 不需要改的(明确列出,防止过度改动)

`Semaphore`、`DEFAULT_MAX_CONCURRENCY_*`、`effectiveMaxConcurrency`、
`CdpConnectionPool` 的连接管理(ensure/connectFresh/watch/drop/dispose)、
`resolveCdpBackend`、错误分类学(`translateError`)、markdown 管线、
`src/index.ts` 的注册/生命周期接线(`ctx.effect` 里 `provider.dispose()` 不变)。

---

## 5. 测试计划

### 5.1 `tests/cdp-pool.spec.ts`(fake 升级 + 新用例)

fake 体系改造:`FakeConnection` 增加 `defaultContext`(带 `newPage`/`pages` 计数),
browser fake 增加可选 `contexts: () => [defaultContext]`;新建 `FakePage` 带 closed 标记。

新增用例(保持现有用例全绿):

1. **profile acquire 用默认 context**:`acquire(ep, t, 'profile')` 返回
   `persistent: true`、context 为 `contexts()[0]`、page 是新建 fake page;
2. **release 只关 page**(`I1`/`I2`):release 后 `page.closed === true`,而
   default context 的 close 计数**恒为 0**(这是本特性最重要的断言);
3. **isolated 行为不变**:每次 acquire `newContext`,release 关 page + context;
4. **连接缺 `contexts()` 时给可诊断错误**;
5. **断连重连后取新连接的默认 context**(不跨连接缓存句柄,3.3);
6. **并发 profile acquire**:N 个并发 lease 共享同一 default context,各自拿到不同
   page,逐一 release 各关各的 page。

### 5.2 `tests/provider.spec.ts`

- `fakeSession` / `fakeCdpConnection` 补 `page` 与 `persistent` 维度;
- 新增:
  1. profile 模式 fetch 结束后:page 关闭、context 未关、browser 未关;
  2. isolated/local 模式:page/context(/browser)按序全关(顺手锁定 4.4(a) 的显式
     page.close 修复);
  3. **abort 中断 profile fetch**:page 关闭、default context 仍可用(模拟"其他 tab
     不受影响");
  4. popup 守卫:`page.on('popup')` 注册的监听器会关闭弹窗 fake。

### 5.3 手动验收(真实浏览器,附录 B 有脚本)

1. 按附录 A 启动远端浏览器(持久 user-data-dir),人工登录某需要登录的站点;
2. 插件设置:`backend: cdp`、`cdpEndpoint` 指向该浏览器、`contextMode: profile`;
3. `web_fetch` 该站点的登录后页面 → 返回内容应包含登录态才可见的部分;
4. fetch 期间观察远端浏览器:出现一个 tab,结束后消失;人工打开的其他 tab 不受影响、
   其图片正常加载(验证 I4 的 page 级过滤);
5. 改回 `contextMode: isolated` → 同一 URL 返回匿名视图(回归确认 I5);
6. 远端浏览器重启(登录态仍在,因为 user-data-dir 持久)→ 下一次 fetch 自动重连成功。

---

## 6. 风险与已知取舍(须写入 README)

1. **带凭证的 prompt injection(最重要的语义变化)**:profile 模式下 `web_fetch` 从
   "匿名读网页"升级为"以用户登录身份行动"。被 fetch 的恶意页面若诱导 agent 请求
   GET 型状态变更 URL(登出、改设置、API 操作),请求会自动携带会话 cookie。
   缓解:README 明示;下游可考虑 URL 黑名单/同源限制类加固(后续工作)。
2. **同站并发 cookie 竞争**:同一站点两个并发 fetch 共享 cookie jar,一方的 set-cookie
   /登出会污染另一方(需求已确认接受;将来可选"同 origin 串行"开关)。
3. **状态只增不减**:默认 context 无法回收(F6),远端 profile 的累积(cookie、缓存、
   service worker)由浏览器自身与运维管理,插件绝不尝试清理。
4. **CDP lower fidelity**(F8):page 级 route 拦截对 service worker 控制的请求可能
   不生效,资源过滤是 best-effort(现有 try/catch 降级保留)。
5. **运维共享**:profile 模式与人工使用同一个浏览器,人工 tab 与 fetch tab 同
   context。I4 保证插件不干扰人工 tab;反向(人工操作影响 fetch)属预期。
6. **可复现性**:输出开始依赖浏览器历史(A/B 分桶、语言偏好),属预期代价。

---

## 7. 验收清单

- [ ] `contextMode` 出现在设置卡片(仅 CDP 选项下可编辑),schema 校验 + 默认 `isolated`
- [ ] profile 模式:fetch 使用远端登录态(5.3 步骤 3 通过)
- [ ] profile 模式:fetch 结束/abort 后远端浏览器中 tab 消失,浏览器与其他 tab 存活
- [ ] 全部测试通过,含 5.1/5.2 新用例(尤其"默认 context close 计数恒为 0")
- [ ] `isolated` 与 `local` 模式行为与改动前一致(零回归)
- [ ] 池 dispose/换 endpoint 后远端浏览器仍存活(F7 语义未被破坏)
- [ ] README(en/zh)含风险说明与附录 A 的远端浏览器启动指引;disclosure 更新

---

## 附录 A:远端浏览器标准启动方式

登录态持久的前提是 **user-data-dir 持久化**。有头(推荐,便于人工预登录):

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/chrome-dsh-profile"
```

服务器无显示器(登录态需先在有头环境预置,或用远程调试预登录一次):

```bash
chromium \
  --headless=new \
  --remote-debugging-port=9222 \
  --user-data-dir=/data/chrome-dsh-profile
```

注意:官方 NOTE 提醒"不用 Playwright 启动浏览器时若参数不一致,部分 Playwright 功能
可能受影响"(即 F8);不要给该浏览器叠加 `--incognito` 或一次性 user-data-dir。

## 附录 B:快速验证脚本(用插件自带的 playwright-core)

```js
// node verify-profile.mjs —— 在插件目录下运行
import { chromium } from './node_modules/playwright-core/index.mjs'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]                    // 默认 context(真实 profile)
console.log('contexts:', browser.contexts().length, '| existing pages:', ctx.pages().length)

const page = await ctx.newPage()                     // ← profile 模式每次 fetch 做的事
await page.goto('https://httpbin.org/cookies')       // 该端点回显 cookie jar
console.log(await page.content())                    // 已登录站点的 cookie 应出现在这里
await page.close()                                   // ← release 只做这件事

await browser.close()                                // 仅断开连接(F7),远端浏览器存活
```

## 附录 C:源码证据索引(1.62.1,`node_modules/playwright-core/lib/coreBundle.js`)

| 事实 | 位置(bundle 行号) | 关键符号/摘录 |
|---|---|---|
| F1 | ~42855 / ~38110 | `const persistent = { noDefaultViewport: true, ... }`;`browser._defaultContext = new CRBrowserContext(browser, void 0, options.persistent)` |
| F2 | `types/types.d.ts` 16825–16851 | "The default browser context is accessible via `browser.contexts()`" + 官方示例 `contexts()[0]` |
| F3 | ~55056 | BrowserDispatcher 先派发 `_defaultContext`,再派发 `browser.contexts()` |
| F4 | ~38125 | `doCreateNewContext` → `Target.createBrowserContext` |
| F5 | ~38340 | `doCreateNewPage` → `Target.createTarget`(默认 context 无 `browserContextId`) |
| F6 | ~38493 / ~51600 / ~42830 | `return "close-browser"` → `this._browser.close()` → `chromeTransport.closeAndWait()`(仅断开) |
| F7 | ~42850 | `browserProcess = { close: doClose, kill: doClose }`,`doClose` = 传输层关闭 + 临时目录清理 |
| F8 | `types/types.d.ts` 同 F2 | "significantly lower fidelity than the Playwright protocol connection" |

行号会随版本漂移;定位方式:在 bundle 内搜索 `"close-browser"`、`_defaultContext`、
`BrowserDispatcher`、`Target.createBrowserContext` 等符号。
