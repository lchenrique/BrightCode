/**
 * Screenshot the avatar picker grid in CreateAgentDialog.
 *
 *   1. Open the modal — show closed.
 *   2. Click the avatar button — show the 4x3 grid of bottts.
 *   3. Pick an alternate seed — show updated avatar.
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

await sleep(500)

// Open the modal
await evalExpr(`document.querySelector('button[aria-label="Add agent"]')?.click()`)
await sleep(500)
await snap('agent-avatar-01-modal-open.png')

// Open the avatar picker
await evalExpr(`document.querySelector('button[aria-label="Pick agent avatar"]')?.click()`)
await sleep(400)
await snap('agent-avatar-02-picker-open.png')

// Pick an alternate seed
await evalExpr(`document.querySelector('button[aria-label="Use avatar agent-glade"]')?.click()`)
await sleep(400)
await snap('agent-avatar-03-picked.png')

console.log('OK')
ws.close()
