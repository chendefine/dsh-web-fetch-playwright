#!/usr/bin/env node
/**
 * The issue #2 before/after demo: a local server simulating a strict
 * Cloudflare edge (managed challenge that clears naturally after ~6.5s in a
 * real browser, an SPA-clearing variant, and a never-clearing hard case),
 * fetched twice through the provider — once with the challenge wait off
 * (the 0.2.4 baseline behavior), once with it on.
 *
 * Usage: node scripts/challenge-demo.mjs   (from the repo root, after build)
 */
import { createServer } from 'node:http'
import { PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE } from '../lib/index.js'

const GUARDED_ARTICLE = `<!doctype html><html><head><title>Simulated protected article</title></head><body>
<main><article><h1>Real protected content</h1>
<p>This paragraph only renders once the simulated Cloudflare challenge has cleared inside the browser itself, and there is enough prose for the article extractor to lock onto the main content region.</p>
<p>A second paragraph of real body text.</p>
</article></main>
</body></html>`

function challengePage(clearAfterMs, spa) {
  const clearScript = clearAfterMs === null
    ? 'setTimeout(function () {}, 1000);'
    : spa
      ? `setTimeout(function () {
        document.title = 'Simulated protected article';
        document.body.innerHTML = document.getElementById('spa-payload').textContent;
        history.replaceState(null, '', '/spa?cleared=1');
      }, ${String(clearAfterMs)});`
      : `setTimeout(function () {
        document.cookie = 'cf_clearance=sim; path=/';
        location.reload();
      }, ${String(clearAfterMs)});`
  return `<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><div class="main-content">
<div id="challenge-stage"><div id="challenge-running">Verifying you are human. This may take a few seconds.</div></div>
<div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: SIMULATED012345</span></div></div>
</div>
<template id="spa-payload">${spa ? '<main><article><h1>Real protected content</h1><p>The SPA swap replaced the challenge shell with the real document; enough prose for the article extractor to lock on.</p><p>A second paragraph.</p></article></main>' : ''}</template>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/simulated" async></script>
<script>window._cf_chl_opt = { cvId: 3 };
${clearScript}</script>
</body></html>`
}

const CHALLENGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cf-mitigated': 'challenge', server: 'cloudflare' }

const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (url.startsWith('/cdn-cgi/')) {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end('// simulated challenge platform script')
    return
  }
  if (url.startsWith('/spa')) {
    res.writeHead(403, CHALLENGE_HEADERS)
    res.end(challengePage(5_500, true))
    return
  }
  if (url.startsWith('/hard')) {
    res.writeHead(403, CHALLENGE_HEADERS)
    res.end(challengePage(null, false))
    return
  }
  if ((req.headers.cookie ?? '').includes('cf_clearance=')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(GUARDED_ARTICLE)
    return
  }
  res.writeHead(403, CHALLENGE_HEADERS)
  res.end(challengePage(6_500, false))
})

await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
const { port } = server.address()
const base = `http://127.0.0.1:${String(port)}/`

function textOf(result) {
  return result.body.content
}

function classify(text) {
  return /just a moment/i.test(text) ? 'CHALLENGE GARBAGE ("Just a moment...")' : 'REAL CONTENT'
}

async function run(provider, label, url) {
  const started = Date.now()
  try {
    const result = await provider.fetch({ url })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  ${label.padEnd(28)} status=${String(result.statusCode).padEnd(3)} ${seconds.padStart(5)}s  → ${classify(textOf(result))}`)
  } catch (error) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const code = error?.code ?? 'UNKNOWN'
    console.log(`  ${label.padEnd(28)} ${code.padEnd(22)} ${seconds.padStart(5)}s  → ${error instanceof Error ? error.message.slice(0, 90) : String(error)}`)
  }
}

function makeProvider(challengeWaitMs, challengeRetries) {
  return new PlaywrightFetchProvider(() => ({
    backend: 'local',
    playwrightPath: '',
    cdpEndpoint: '',
    shareBrowserContext: true,
    denoise: true,
    maxConcurrency: 4,
    challengeWaitMs,
    challengeRetries,
  }))
}

console.log('=== dsh-web-fetch-playwright issue #2 — bounded natural challenge wait, A/B demo ===')
console.log(`simulated strict Cloudflare edge at ${base}\n`)

for (const [route, note] of [['', 'managed challenge, clears naturally after 6.5s'], ['spa', 'SPA clear: shell swaps content at 5.5s, no navigation'], ['hard', 'never clears (interactive-only)']]) {
  console.log(`— ${base}${route || '(article)'}  (${note})`)
  const baseline = makeProvider(0, 0) // 0.2.4 behavior
  await run(baseline, 'baseline challengeWaitMs=0', `${base}${route}`)
  await baseline.dispose()
  const feature = makeProvider(12_000, 1)
  await run(feature, 'feature challengeWaitMs=12000', `${base}${route}`)
  await feature.dispose()
  console.log()
}

console.log('expected: baselines return the interstitial as content (the reported bug);')
console.log('feature runs return REAL CONTENT, and the hard case fails with')
console.log(`${WEB_FETCH_CHALLENGE_CODE} after the bounded window instead of returning garbage.`)
server.close()
process.exit(0)
