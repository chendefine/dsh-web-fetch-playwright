/**
 * Locates a usable Playwright for the local backend. Resolution order:
 *
 *  1. the configured executable/document path (settings field `playwrightPath`);
 *  2. when blank, a `playwright` executable discovered on `$PATH`;
 *  3. the plugin's own bundled `playwright-core` dependency.
 *
 * A discovered path is classified, not assumed: the Node `playwright` CLI
 * yields its package (whose `chromium` knows that installation's browser
 * registry), while a Chromium-family browser binary yields the bundled
 * `playwright-core` with `executablePath` pinned to it. The CDP backend needs
 * no local browsers at all and always uses the bundled core.
 *
 * Pure probing lives here; the provider composes it with page navigation.
 *
 * @module dsh-web-fetch-playwright/playwright-resolve
 */

import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { PlaywrightChromium } from './types.ts'

/** File magics identifying a native browser executable rather than a script. */
const EXECUTABLE_MAGICS = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF (Linux)
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // Mach-O 64 LE (macOS)
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // Mach-O fat (macOS)
  Buffer.from([0x4d, 0x5a]), // MZ (Windows)
]

/** A resolved local backend: how to reach `chromium` and what to launch. */
export interface ResolvedPlaywright {
  /** The `chromium` namespace serving `launch` / `connectOverCDP`. */
  chromium: PlaywrightChromium
  /** Browser binary pinned for `launch({ executablePath })`, when one was configured. */
  executablePath?: string
  /** Provenance for diagnostics. */
  source: string
}

/**
 * Find `name` as an executable file on `$PATH`.
 * @param name - the executable basename.
 * @returns the first matching path, or undefined.
 */
export function findOnPath(name: string): string | undefined {
  const pathValue = process.env.PATH ?? ''
  for (const dir of pathValue.split(':')) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      const stat = statSync(candidate)
      if (!stat.isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // missing or not executable — keep scanning
    }
  }
  return undefined
}

/**
 * Whether a file starts with a native-executable magic (ELF / Mach-O / MZ).
 * @param path - the file to sniff.
 * @returns true when the file is a compiled binary.
 */
export function isNativeExecutable(path: string): boolean {
  let head: Buffer
  try {
    head = readFileSync(path).subarray(0, 4)
  } catch {
    return false
  }
  return EXECUTABLE_MAGICS.some(magic => head.subarray(0, magic.length).equals(magic))
}

/**
 * Walk up from a file (or the file's own directory) to the nearest package
 * root whose manifest names Playwright.
 * @param start - a file path inside or beside the candidate package.
 * @param maxHops - upward directory bound.
 * @returns the package root directory, or undefined.
 */
export function findPlaywrightPackageRoot(start: string, maxHops = 6): string | undefined {
  let dir = statSync(start).isDirectory() ? start : dirname(start)
  // Symlinked bins (npm global layout) resolve to the real package files.
  try {
    const real = realpathSync(dir)
    dir = real
  } catch {
    // keep the literal path
  }
  for (let hop = 0; hop <= maxHops; hop++) {
    const manifest = join(dir, 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
      if (pkg.name === 'playwright' || pkg.name === 'playwright-core' || pkg.name === '@playwright/test') return dir
    } catch {
      // no manifest here — keep climbing
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/**
 * Import the Playwright package rooted at `root`, preferring its ESM entry
 * with a CommonJS fallback.
 * @param root - the package root directory.
 * @returns the package's default export (the Playwright module).
 */
async function importPlaywrightPackage(root: string): Promise<{ chromium?: unknown }> {
  const require = createRequire(join(root, 'package.json'))
  const entry = require.resolve('.')
  return await import(pathToFileURL(entry).href) as { chromium?: unknown }
}

/** Memoized successful resolutions, keyed by the configured path ("" = auto). */
const resolvedCache = new Map<string, ResolvedPlaywright>()

/**
 * Resolve the local Playwright backend for one fetch.
 *
 * @param configuredPath - the settings `playwrightPath` (blank = auto-discover).
 * @returns how to launch/connect, with provenance for diagnostics.
 * @throws {Error} with an actionable message when nothing usable exists.
 */
export async function resolvePlaywrightBackend(configuredPath: string): Promise<ResolvedPlaywright> {
  const trimmed = configuredPath.trim()
  const cacheKey = trimmed
  const cached = resolvedCache.get(cacheKey)
  if (cached !== undefined) return cached

  const candidate = trimmed !== '' ? trimmed : findOnPath('playwright')
  if (trimmed !== '' && !existsAsFile(trimmed)) {
    throw new Error(`configured playwright path "${trimmed}" does not exist`)
  }

  if (candidate !== undefined && isNativeExecutable(candidate)) {
    // A pinned browser binary: drive it with the bundled core.
    const core = await importBundledCore()
    const resolved: ResolvedPlaywright = {
      chromium: core,
      executablePath: realpathSync(candidate),
      source: `browser executable ${candidate} (bundled playwright-core)`,
    }
    resolvedCache.set(cacheKey, resolved)
    return resolved
  }

  if (candidate !== undefined) {
    const root = findPlaywrightPackageRoot(candidate)
    if (root !== undefined) {
      const pkg = await importPlaywrightPackage(root)
      const chromium = pkg.chromium
      if (chromium !== undefined && typeof (chromium as PlaywrightChromium).launch === 'function') {
        const resolved: ResolvedPlaywright = {
          chromium: chromium as PlaywrightChromium,
          source: `playwright package at ${root}${trimmed === '' ? ' (discovered on $PATH)' : ''}`,
        }
        resolvedCache.set(cacheKey, resolved)
        return resolved
      }
    }
    // A script that is neither a Playwright CLI nor a browser binary.
    if (trimmed !== '') {
      throw new Error(`configured playwright path "${trimmed}" is neither a Playwright CLI nor a browser executable`)
    }
  }

  const core = await importBundledCore()
  const resolved: ResolvedPlaywright = {
    chromium: core,
    source: 'bundled playwright-core (no playwright found on $PATH; browsers must be discoverable, or set the path)',
  }
  resolvedCache.set(cacheKey, resolved)
  return resolved
}

/** The CDP backend: the bundled core only — no local browser registry needed. */
export async function resolveCdpBackend(): Promise<ResolvedPlaywright> {
  const core = await importBundledCore()
  return { chromium: core, source: 'bundled playwright-core over CDP' }
}

let bundledCore: PlaywrightChromium | undefined

async function importBundledCore(): Promise<PlaywrightChromium> {
  if (bundledCore !== undefined) return bundledCore
  const pkg = await import('playwright-core') as { chromium?: unknown }
  const chromium = pkg.chromium
  if (chromium === undefined || typeof (chromium as PlaywrightChromium).launch !== 'function') {
    throw new Error('playwright-core dependency did not export a usable chromium namespace')
  }
  bundledCore = chromium as PlaywrightChromium
  return bundledCore
}

function existsAsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
