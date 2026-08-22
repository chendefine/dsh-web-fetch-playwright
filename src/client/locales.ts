/**
 * Locale bundles for the Playwright card (the plugin's own dictionary
 * namespace, registered with the client locale service).
 *
 * @module dsh-web-fetch-playwright/client/locales
 */

/** Locale keys this card renders. */
export type PlaywrightCardLocaleKey =
  | 'title' | 'description'
  | 'backendLabel' | 'backendLocal' | 'backendLocalHint' | 'backendCdp' | 'backendCdpHint'
  | 'playwrightPath' | 'playwrightPathHint' | 'playwrightPathPlaceholder'
  | 'cdpEndpoint' | 'cdpEndpointHint'
  | 'denoise' | 'denoiseHint'
  | 'maxConcurrency' | 'maxConcurrencyHint' | 'maxConcurrencyPlaceholder'
  | 'overridden' | 'reset' | 'readOnly' | 'expand' | 'collapse'
  | 'save' | 'saving' | 'discard' | 'unsaved' | 'saveFailed' | 'invalidText'

/** This plugin's dictionary namespace, merged into the locale key map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'web-fetch-playwright': PlaywrightCardLocaleKey
  }
}

/** English copy. */
export const en: Record<PlaywrightCardLocaleKey, string> = {
  title: 'Playwright web fetch',
  description: 'Fetches pages with a real browser (local Playwright or CDP) and returns denoised markdown.',
  backendLabel: 'Playwright backend',
  backendLocal: 'Local Playwright',
  backendLocalHint: 'Launch a browser through the local playwright installation.',
  backendCdp: 'Remote CDP endpoint',
  backendCdpHint: 'Drive an already-running browser over its DevTools Protocol port.',
  playwrightPath: 'Playwright executable path',
  playwrightPathHint: 'Leave blank to find playwright on $PATH; a browser executable path also works.',
  playwrightPathPlaceholder: '(auto: playwright from $PATH)',
  cdpEndpoint: 'CDP endpoint',
  cdpEndpointHint: 'host:port or http(s)/ws URL. Leave blank for 127.0.0.1:9222.',
  denoise: 'Enable the denoise algorithm',
  denoiseHint: 'Readability + DOMPurify strip nav bars, sidebars, footers, and ads before converting to markdown.',
  maxConcurrency: 'Max concurrent fetches',
  maxConcurrencyHint: 'How many pages may render at once (1–200). Blank = auto: 4 local browsers, 50 CDP tabs in the remote browser.',
  maxConcurrencyPlaceholder: '(auto: local 4 / CDP 50)',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  expand: 'Show settings',
  collapse: 'Hide settings',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  unsaved: 'Unsaved',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidText: 'This value is not accepted here.',
}

/** Simplified Chinese copy. */
export const zh: Record<PlaywrightCardLocaleKey, string> = {
  title: 'Playwright 网页爬取',
  description: '用真实浏览器（本地 Playwright 或 CDP）抓取网页，降噪后转为 Markdown。',
  backendLabel: 'Playwright 后端',
  backendLocal: '本地 Playwright',
  backendLocalHint: '通过本机的 playwright 安装启动浏览器。',
  backendCdp: '远端 CDP 地址',
  backendCdpHint: '连接一个已在运行的浏览器的 DevTools 协议端口。',
  playwrightPath: 'Playwright 可执行文件路径',
  playwrightPathHint: '留空则按系统 $PATH 查找 playwright；也支持填浏览器可执行文件路径。',
  playwrightPathPlaceholder: '（自动：按 $PATH 查找 playwright）',
  cdpEndpoint: 'CDP 地址',
  cdpEndpointHint: 'host:port 或 http(s)/ws 地址；留空默认 127.0.0.1:9222。',
  denoise: '启用降噪算法',
  denoiseHint: '使用 Readability + DOMPurify 清洗导航栏、侧边栏、页脚与贴片广告后再转为 Markdown。',
  maxConcurrency: '最大并发抓取数',
  maxConcurrencyHint: '同时渲染的页面上限（1–200）；留空自动：本地 4 个浏览器，CDP 在远端浏览器里 50 个标签页。',
  maxConcurrencyPlaceholder: '（自动：本地 4 / CDP 50）',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  expand: '展开设置',
  collapse: '收起设置',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  unsaved: '未保存',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidText: '该值不被此设置项接受。',
}
