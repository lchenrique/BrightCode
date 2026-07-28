import { writeFileSync } from 'node:fs'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url && !t.url.includes('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
  if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
    console.log('LOG:', JSON.stringify(msg.params).slice(0, 500))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((r) => pending.set(i, r)) }
const evalExpr = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
await send('Log.enable', {})
await send('Runtime.enable', {})

await new Promise((r) => setTimeout(r, 2500))
const r = await evalExpr(`document.body.innerHTML.slice(0, 1000)`)
console.log('body:', r.result?.value)
ws.close()
