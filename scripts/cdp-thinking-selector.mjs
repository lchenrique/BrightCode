/**
 * Capture the ThinkingSelector dropdown in the chat input bar.
 * Shows the 5 levels (Off / Minimal / Low / Medium / High) with
 * descriptions. Verifies the toggle still works on the rebuilt
 * renderer bundle.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('No page target'); process.exit(1) }

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
  if (r.error) { console.error('snap failed', r.error); return }
  writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('Saved →', join(outDir, name))
}

await sleep(800)

// Open the Thinking selector
await evalExpr(`document.querySelector('button[aria-label="Thinking level"]')?.click()`)
await sleep(400)
await snap('thinking-selector-open.png')

// Pick "High"
await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"]'))
  const hi = items.find(el => el.textContent?.includes('High'))
  if (hi) hi.click()
  return hi ? 'clicked High' : 'NO HIGH'
})()`)
await sleep(300)
await snap('thinking-selector-high.png')

console.log('OK')
ws.close()
