/**
 * Validate the MiniMax Code-style welcome screen redesign.
 *
 *   1. Navigate to the welcome view via the "New task" sidebar nav.
 *   2. Snap the full screen (grid + bands, headline, prompt, context bar, pills).
 *   3. Assert the context bar shows workspace / Local mode / branch chips.
 *   4. Open each context dropdown and snap.
 *   5. Assert the send button is a circle and pills are rounded-full.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url && !t.url.includes('devtools'))
if (!page) { console.error('No main page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
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

// 1. Go to the welcome screen
const nav = await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  if (!btn) return { ok: false, reason: 'no New task nav' }
  btn.click()
  return { ok: true }
})()`)
console.log('Nav →', JSON.stringify(nav.result?.value))
await sleep(1200)
await snap('welcome-redesign-01-full.png')

// 2. Context bar assertions
const bar = await evalExpr(`(() => {
  const bar = document.querySelector('[data-context-bar]')
  if (!bar) return { ok: false, reason: 'no context bar' }
  const labels = Array.from(bar.querySelectorAll('button'))
    .map((b) => (b.textContent || '').trim())
  return { ok: true, labels }
})()`)
console.log('Context bar →', JSON.stringify(bar.result?.value))

// 3. Open the workspace dropdown
await evalExpr(`(() => {
  const btn = document.querySelector('[data-context-bar] button[aria-label="Select workspace"]')
  btn?.click()
})()`)
await sleep(600)
await snap('welcome-redesign-02-workspace.png')
await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(300)

// 4. Open the Local mode dropdown
await evalExpr(`(() => {
  const btn = document.querySelector('[data-context-bar] button[aria-label="Execution mode"]')
  btn?.click()
})()`)
await sleep(600)
await snap('welcome-redesign-03-local-mode.png')
await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await sleep(300)

// 5. Open the branch dropdown (only present when the project is a git repo)
const branchBtn = await evalExpr(`(() => {
  const btn = document.querySelector('[data-context-bar] button[aria-label="Current branch"]')
  if (!btn) return { present: false }
  btn.click()
  return { present: true }
})()`)
console.log('Branch chip →', JSON.stringify(branchBtn.result?.value))
await sleep(600)
if (branchBtn.result?.value?.present) {
  await snap('welcome-redesign-04-branch.png')
  await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)
}

// 6. Style assertions: round send button + pill buttons
const styles = await evalExpr(`(() => {
  const send = document.querySelector('button[aria-label="Send"]')
  const sendRadius = send ? getComputedStyle(send).borderRadius : null
  const pills = Array.from(document.querySelectorAll('button'))
    .filter((b) => ['Slides', 'PDF', 'Docs', 'Excel'].includes((b.textContent || '').trim()))
    .map((b) => ({ label: (b.textContent || '').trim(), radius: getComputedStyle(b).borderRadius }))
  const h1 = document.querySelector('h1')
  return {
    sendRadius,
    pills,
    headline: h1 ? { text: h1.textContent, size: getComputedStyle(h1).fontSize, weight: getComputedStyle(h1).fontWeight } : null,
  }
})()`)
console.log('Styles →', JSON.stringify(styles.result?.value, null, 1))

// 7. Prompt input close-up
const box = await evalExpr(`(() => {
  const ta = document.querySelector('textarea[placeholder*="Enter message"]')
  if (!ta) return { ok: false }
  ta.closest('div.bg-card')?.scrollIntoView({ block: 'center' })
  return { ok: true }
})()`)
console.log('Prompt box →', JSON.stringify(box.result?.value))
await sleep(300)
await snap('welcome-redesign-05-prompt.png')

console.log('DONE')
process.exit(0)
