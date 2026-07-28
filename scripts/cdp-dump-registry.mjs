/** Dump all registered providers + their credential state. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

const dump = await evalExpr(`(function() {
  const reg = window.__brightcodeRegistry
  if (!reg) return { ok: false, reason: 'no registry' }
  const all = reg.list()
  const out = []
  for (const p of all) {
    const hasCred = reg.hasCredential(p.id)
    const accounts = reg.listAccounts(p.id)
    out.push({
      id: p.id,
      name: p.name,
      credentialProviderId: p.credentialProviderId,
      hasCredential: hasCred,
      accountCount: accounts.length,
      models: p.listModels().map((m) => m.id),
    })
  }
  return { ok: true, providers: out }
})()`)
console.log('REGISTRY →', JSON.stringify(dump.result?.value, null, 1))

const grouped = await evalExpr(`(function() {
  const reg = window.__brightcodeRegistry
  const groups = []
  for (const p of reg.list()) {
    const hasCred = reg.hasCredential(p.id)
    const models = reg.listAvailableModels(p.id)
    groups.push({
      id: p.id,
      name: p.name,
      hasCredential: hasCred,
      modelCount: models.length,
      modelIds: models.map((m) => m.id),
    })
  }
  return groups
})()`)
console.log('GROUPED →', JSON.stringify(grouped.result?.value, null, 1))

process.exit(0)
