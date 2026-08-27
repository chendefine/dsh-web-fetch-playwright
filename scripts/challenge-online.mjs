#!/usr/bin/env node
/**
 * Online A/B probe for the issue #2 bounded challenge wait: fetch ONE real
 * URL twice through the provider — once with the challenge wait off (the
 * 0.2.4 baseline behavior), once with it on — and print what each returned.
 *
 * Usage:
 *   node scripts/challenge-online.mjs <url> [--wait ms] [--retries n] [--cdp host:port]
 *
 * Examples:
 *   node scripts/challenge-online.mjs https://www.scrapingcourse.com/cloudflare-challenge
 *   node scripts/challenge-online.mjs https://example.com --cdp 127.0.0.1:9222 --wait 20000
 *
 * Exit posture: this only ever *observes*; it never tries to bypass anything.
 */
import { PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE } from '../lib/index.js'

function parseArgs(argv) {
  const url = argv.find(arg => !arg.startsWith('--'))
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index !== -1 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
  }
  if (url === undefined) {
    console.error('usage: node scripts/challenge-online.mjs <url> [--wait ms] [--retries n] [--cdp host:port]')
    process.exit(2)
  }
  return {
    url,
    waitMs: Number(flag('--wait', 15_000)),
    retries: Number(flag('--retries', 1)),
    cdp: flag('--cdp', ''),
  }
}

const args = parseArgs(process.argv.slice(2))

function makeProvider(challengeWaitMs, challengeRetries) {
  const config = {
    denoise: true,
    challengeWaitMs,
    challengeRetries,
  }
  if (args.cdp !== '') {
    return new PlaywrightFetchProvider(() => ({
      ...config,
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: args.cdp,
      // Profile mode by default — the issue's "real browser" setup. Pass an
      // endpoint whose browser you trust to act with its own logins.
      shareBrowserContext: true,
    }))
  }
  return new PlaywrightFetchProvider(() => ({
    ...config,
    backend: 'local',
    playwrightPath: '',
    cdpEndpoint: '',
    shareBrowserContext: true,
    maxConcurrency: 4,
  }))
}

function describe(result) {
  const text = result.body.content
  const looksLikeChallenge = /just a moment|请稍候|請稍候|checking your browser|verifying you are human|минуточку|un momento|einen moment/i.test(text)
  const firstLine = text.split('\n').find(line => line.trim() !== '') ?? ''
  return {
    looksLikeChallenge,
    sample: firstLine.trim().slice(0, 100),
    chars: text.length,
    truncated: result.truncated,
  }
}

async function run(provider, label) {
  const started = Date.now()
  try {
    const result = await provider.fetch({ url: args.url })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const info = describe(result)
    console.log(`  ${label.padEnd(30)} status=${String(result.statusCode).padEnd(3)} ${seconds.padStart(5)}s  body=${String(info.chars).padEnd(6)} chars`)
    console.log(`  ${''.padEnd(30)} verdict=${info.looksLikeChallenge ? 'CHALLENGE PAGE returned as content (the bug)' : 'real content'}  first line: ${info.sample}`)
    return info.looksLikeChallenge ? 'GARBAGE' : 'CONTENT'
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const code = error?.code ?? 'UNKNOWN'
    console.log(`  ${label.padEnd(30)} code=${code} ${seconds}s`)
    console.log(`  ${''.padEnd(30)} message: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`)
    return code
  } finally {
    await provider.dispose()
  }
}

console.log(`=== online A/B — ${args.url} ===`)
console.log(`backend=${args.cdp === '' ? 'local headless chromium' : `cdp ${args.cdp} (profile mode)`}  wait=${String(args.waitMs)}ms retries=${String(args.retries)}\n`)

console.log('[1] baseline — challengeWaitMs=0 (the 0.2.4 behavior):')
const baseline = await run(makeProvider(0, 0), 'baseline')
console.log('\n[2] feature — bounded natural wait:')
const feature = await run(makeProvider(args.waitMs, args.retries), 'feature')
console.log('\n=== reading the result ===')
console.log(`  baseline: ${baseline === 'GARBAGE' ? 'returned the interstitial as content — the reported bug reproduced' : baseline === 'CONTENT' ? 'site let the browser through without a challenge (nothing to wait out here)' : baseline}`)
if (feature === 'CONTENT') {
  console.log('  feature:  returned the real page after the browser cleared the challenge naturally — fix verified end to end')
} else if (feature === WEB_FETCH_CHALLENGE_CODE) {
  console.log('  feature:  classified the failure as WEB_FETCH_CHALLENGE after the bounded window — the other half of the fix:')
  console.log('            a clear, retryable error instead of silent garbage. To get the real page, retry from a')
  console.log('            better-reputation browser/IP: point --cdp at your real headed browser (residential IP),')
  console.log('            or raise --wait; headless Chromium on a datacenter IP is exactly what Cloudflare distrusts.')
} else {
  console.log(`  feature:  ${String(feature)}`)
}
process.exit(0)
