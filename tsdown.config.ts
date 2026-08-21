/**
 * Build config: the host half as a plain ESM bundle, and the browser half as
 * a `window.__ModuleLoader__.load({ id, factory })` registration bundle — the
 * official external client-plugin delivery format (same shape as the shipped
 * web client packages and dsh-cdp-live-view).
 *
 * The client bundle purity gate rejects Node builtins and `@deepseek-ai/*`
 * value imports: the browser half must be self-contained (React comes from
 * the module table; every component and style it needs lives here).
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { builtinModules } from 'node:module'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis']
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(id => `node:${id}`)])
const CSS_PREFIX = '\0dsh-web-fetch-playwright-css:'
const CSS_SUFFIX = '.mjs'
type BuildPlugin = NonNullable<UserConfig['plugins']>

const PLUGIN_ID = 'dsh-web-fetch-playwright'

function injectTag(fileId: string, cssText: string): string {
  const tagId = `${PLUGIN_ID}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

function purityGate(): BuildPlugin {
  return {
    name: 'dsh-web-fetch-playwright-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) throw new Error(`client bundle cannot import Node builtin ${source}`)
      if (source.startsWith('@deepseek-ai/')) throw new Error(`client bundle cannot value-import ${source}`)
      return null
    },
  }
}

function cssPlugin(): BuildPlugin {
  return {
    name: 'dsh-web-fetch-playwright-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      const absolute = source.startsWith('.') && importer !== undefined ? resolvePath(dirname(importer), source) : resolvePath(source)
      return CSS_PREFIX + absolute + CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const fileId = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      if (fileId.endsWith('.module.css')) {
        const result = transform({ filename: fileId, code: source, cssModules: { pattern: '[hash]_[local]' }, minify: true })
        const classes: Record<string, string> = {}
        for (const [local, value] of Object.entries(result.exports ?? {})) classes[local] = value.name
        return `${injectTag(fileId, result.code.toString())}\nexport default ${JSON.stringify(classes)};`
      }
      return `${injectTag(fileId, source.toString('utf8'))}\nexport default "";`
    },
  }
}

function clientBundle(fileName: string): UserConfig {
  return {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    dts: false,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
    noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
    plugins: [purityGate(), cssPlugin()],
    define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
    outputOptions: {
      entryFileNames: fileName,
      codeSplitting: false,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  clientBundle('client.js'),
] satisfies UserConfig[]
