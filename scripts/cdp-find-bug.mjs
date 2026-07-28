/** Figura pra q o picker mostra 1 item so. */
import { writeFileSync } from 'node:fs'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180'))
if (!page) { console.error('No main page'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res) => ws.addEventListener('open', res))
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })

await send('Page.enable', {})
await send('Runtime.enable', {})

// Force welcome screen
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  btn?.click()
})()`)
await new Promise((r) => setTimeout(r, 1200))

// 1) What does listAvailableModelsGrouped actually return?
const groupsLive = await evalExpr(`(function() {
  const reg = window.__brightcodeRegistry
  const raw = reg.listAvailableModelsGrouped()
  return raw.map((g) => ({
    id: g.provider.id,
    name: g.provider.name,
    hasCred: g.hasCredential,
    modelCount: g.models.length,
    freeModels: g.models.filter((m) => m.free).map((m) => m.id),
    paidModels: g.models.filter((m) => !m.free).map((m) => m.id),
  }))
})()`)
console.log('GROUPS LIVE →', JSON.stringify(groupsLive.result?.value, null, 1))

// 2) Now open the picker
await evalExpr(`document.querySelector('button[aria-label="Select model"]')?.click()`)
await new Promise((r) => setTimeout(r, 700))

// Back to provider step
await evalExpr(`(() => {
  const back = document.querySelector('button[aria-label="Back to providers"]')
  back?.click()
})()`)
await new Promise((r) => setTimeout(r, 400))

const items = await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[data-picker-item]'))
  return items.map((i) => ({
    text: (i.textContent || '').trim().slice(0, 60),
    status: i.querySelector('[class*="rounded-full"]')?.className || 'none',
  }))
})()`)
console.log('PICKER ITEMS →', JSON.stringify(items.result?.value, null, 1))

process.exit(0)
