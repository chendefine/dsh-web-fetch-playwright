# dsh-web-fetch-playwright

DSH 双端插件:为内置 `web_fetch` 工具提供一个 Playwright/CDP 后端的 fetch provider——用真实浏览器渲染网页,经 **Readability + DOMPurify + Turndown + GFM** 降噪(清洗导航栏、侧边栏、页脚、贴片广告)后输出 Markdown。

- **宿主半**(`src/`):向 `ctx.web` 注册 fetch provider(id `playwright`);`cordis.patch.yml` 把 web seam 的 `fetchProvider` 固定为本插件,并启用 `web_fetch` 工具(60s 预算)。
- **浏览器半**(`src/client/`):在「设置 → 插件 → 插件配置」注册 *Playwright 网页爬取* 卡片(样式复刻内置「网页搜索」卡片),通过 settings 服务热修改配置,写入 `$DSH_HOME/settings.yaml`。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `local` | radio:本地 Playwright / 远端 CDP 地址,每个选项内嵌各自的填空(本地→可执行文件路径,远端→CDP 地址) |
| `playwrightPath` | 空 | 本地后端:playwright 可执行文件路径;留空按 `$PATH` 查找;也支持填浏览器可执行文件(直接以 `executablePath` 启动) |
| `cdpEndpoint` | 空(CDP 后端默认 `127.0.0.1:9222`) | 远端后端:`host:port` 或 `http(s)://`/`ws(s)://` 地址 |
| `denoise` | `true` | 是否启用降噪算法(关闭时返回整页 HTML,由内置 tool-web 转 Markdown) |

## 后端解析顺序(本地模式)

1. 设置里填了路径 → 按路径(自动判别 playwright CLI / 浏览器二进制);
2. 留空 → `$PATH` 上的 `playwright`(其包自带的浏览器注册表);
3. 都没有 → 插件自带的 `playwright-core`(需要 `PLAYWRIGHT_BROWSERS_PATH` 或默认缓存里有浏览器,否则在报错里提示 `playwright install`)。

CDP 模式不需要本地浏览器,直接 `connectOverCDP`,每次抓取使用独立 context,不污染浏览器已有会话。

## 安装(本仓库为本地开发)

```sh
pnpm install && pnpm typecheck && pnpm test && pnpm build
```

然后经保护流安装并重启部署:

```sh
dshpm install /opt/dsh/plugins/dsh-web-fetch-playwright --profile web
# 或在 DSH Web 里用 plugin_install 工具
```

bundle 插件加入 profile 层栈后,需**重启 dsh web** 生效;卸载用 `dshpm remove dsh-web-fetch-playwright` 再重启。

## 安全边界

与内置 HTTP provider 同立场:未实现 SSRF/私网防护——浏览器能访问的目标,本 provider 就能抓。CDP 地址由设置页配置,不做回环限制,请在可信环境暴露设置页。

## 许可证

MIT
