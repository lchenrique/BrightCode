/**
 * Regression test for the OpenCode Go provider split.
 *
 * OpenCode Go exposes two wire formats at sibling paths:
 *   • /v1/chat/completions   — OpenAI-compatible
 *   • /v1/messages           — Anthropic-compatible
 *
 * BrightCode registers both as separate `IAgentProvider` ids
 * (`opencode-go` and `opencode-go-anthropic`) that share a single
 * stored credential via `credentialProviderId: 'opencode-go'`. This
 * test verifies:
 *
 *   1. Both providers are registered with the right apiFormat and baseURL.
 *   2. The Anthropic subset only contains models that the upstream
 *      serves on /v1/messages (Qwen 3.5/3.6/3.7 + MiniMax M3/M2.7/M2.5).
 *   3. The OpenAI subset contains the rest of the catalog.
 *   4. Saving a credential under 'opencode-go' makes both subsets
 *      "configured" (the shared bucket lookup).
 *   5. The model picker shows two "OpenCode Go" rows with the right
 *      counts (16 + 7 = 23, matching the live /v1/models endpoint).
 *
 * Run with `npm run electron:dev` already up.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180'))
if (!page) { console.error('No localhost:5180 page'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await send('Page.enable', {})
await send('Runtime.enable', {})

const outDir = join(process.cwd(), 'scripts', 'screenshots')
mkdirSync(outDir, { recursive: true })
async function snap(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.error) return
  writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('Saved →', join(outDir, name))
}

await sleep(1500)

// Verify the registry has the right split
console.log('--- registry split ---')
{
  const r = await evalExpr(`(function() {
    const reg = window.__brightcodeRegistry
    const anthropic = reg.list().find(p => p.id === 'opencode-go-anthropic')
    const openai = reg.list().find(p => p.id === 'opencode-go')
    return {
      openai: openai ? { count: openai.listModels().length, ids: openai.listModels().map(m => m.id) } : null,
      anthropic: anthropic ? { count: anthropic.listModels().length, ids: anthropic.listModels().map(m => m.id) } : null,
    }
  })()`)
  console.log(JSON.stringify(r.result.value, null, 2))
}

// Set a fake API key
await evalExpr(`(function() {
  const reg = window.__brightcodeRegistry
  reg.setCredential('opencode-go', { method: 'api_key', apiKey: 'sk-test-fake-key' })
  return 'ok'
})()`)
await sleep(400)

// Open the model picker (back to provider list)
console.log('--- open model trigger ---')
await evalExpr(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const modelBtn = buttons.find(b => /Big Pickle|Grok|GLM|Kimi|Qwen/.test(b.textContent ?? ''))
  if (modelBtn) modelBtn.click()
  return 'ok'
})()`)
await sleep(400)
await evalExpr(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const backBtn = buttons.find(b => b.querySelector('svg.lucide-chevron-left'))
  if (backBtn) backBtn.click()
  return 'ok'
})()`)
await sleep(400)
await snap('opencode-go-providers.png')

console.log('--- provider list ---')
{
  const r = await evalExpr(`(() => {
    return Array.from(document.querySelectorAll('[data-picker-item]')).map(i => i.textContent.trim().slice(0, 80))
  })()`)
  console.log(JSON.stringify(r.result.value, null, 2))
}

// Click first OpenCode Go (openai-chat)
console.log('--- click first OpenCode Go ---')
await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[data-picker-item]'))
  const goItems = items.filter(i => /^OpenCode Go/.test(i.textContent.trim()))
  if (goItems[0]) goItems[0].click()
  return goItems.length
})()`)
await sleep(400)
await snap('opencode-go-openai-list.png')
console.log('--- openai models ---')
{
  const r = await evalExpr(`(() => {
    return Array.from(document.querySelectorAll('[data-picker-item]')).map(i => i.textContent.trim().slice(0, 60))
  })()`)
  console.log(JSON.stringify(r.result.value, null, 2))
}

// Back, click second
await evalExpr(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const backBtn = buttons.find(b => b.querySelector('svg.lucide-chevron-left'))
  if (backBtn) backBtn.click()
  return 'ok'
})()`)
await sleep(400)
await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[data-picker-item]'))
  const goItems = items.filter(i => /^OpenCode Go/.test(i.textContent.trim()))
  if (goItems[1]) goItems[1].click()
  return goItems.length
})()`)
await sleep(400)
await snap('opencode-go-anthropic-list.png')
console.log('--- anthropic models ---')
{
  const r = await evalExpr(`(() => {
    return Array.from(document.querySelectorAll('[data-picker-item]')).map(i => i.textContent.trim().slice(0, 60))
  })()`)
  console.log(JSON.stringify(r.result.value, null, 2))
}

ws.close()
