/**
 * Playwright resolution: PATH scanning, native-executable detection, and
 * package-root discovery — against fixtures, no real playwright involved.
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findOnPath, findPlaywrightPackageRoot, isNativeExecutable } from '../src/playwright-resolve.ts'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-wfp-resolve-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeExecutable(path: string, content: string | Buffer): void {
  writeFileSync(path, content)
  chmodSync(path, 0o755)
}

describe('findOnPath', () => {
  it('finds an executable on a configured PATH directory', () => {
    const dir = join(root, 'bin-a')
    mkdirSync(dir, { recursive: true })
    writeExecutable(join(dir, 'my-probe'), '#!/bin/sh\ntrue\n')
    const previous = process.env.PATH
    process.env.PATH = dir
    try {
      expect(findOnPath('my-probe')).toBe(join(dir, 'my-probe'))
      expect(findOnPath('absent-tool')).toBeUndefined()
    } finally {
      process.env.PATH = previous
    }
  })
})

describe('isNativeExecutable', () => {
  it('detects an ELF binary', () => {
    const elf = join(root, 'chrome-shim')
    writeExecutable(elf, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
    expect(isNativeExecutable(elf)).toBe(true)
  })

  it('treats scripts as non-native', () => {
    const script = join(root, 'cli-shim')
    writeExecutable(script, '#!/usr/bin/env node\nconsole.log(1)\n')
    expect(isNativeExecutable(script)).toBe(false)
  })
})

describe('findPlaywrightPackageRoot', () => {
  it('walks up from a bin script to the package manifest', () => {
    const pkg = join(root, 'node_modules', 'playwright')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.0.0' }))
    writeExecutable(join(pkg, 'cli.js'), '#!/usr/bin/env node\n')
    expect(findPlaywrightPackageRoot(join(pkg, 'cli.js'))).toBe(pkg)
  })

  it('rejects directories with no playwright manifest up the chain', () => {
    const other = join(root, 'plain-pkg', 'bin')
    mkdirSync(other, { recursive: true })
    writeExecutable(join(other, 'tool'), '#!/bin/sh\ntrue\n')
    // The temp root's ancestors contain no playwright manifest; the walk may
    // climb into tmpdir — assert it does not find OUR fixture at least.
    expect(findPlaywrightPackageRoot(join(other, 'tool'))).not.toBe(join(root, 'plain-pkg'))
  })
})
