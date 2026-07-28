/**
 * Screenshot the redesigned Environmental Info panel
 * matching the MiniMax Code visual style.
 *
 *   1. Open the env panel and snap the default collapsed state.
 *   2. Snap the expanded state (the auto-opened Commit section).
 *   3. Open the file diff for a change.
 *   4. Back to list — confirm collapsed state restored.
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

// 0. Open task if not in one
const t = await evalExpr(`(() => {
  if (document.querySelector('button[aria-label="Toggle environment info"]')) {
    return { already: true }
  }
  const task = Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === 'oi')
  task?.click()
  return { clicked: true }
})()`)
console.log('Task open →', JSON.stringify(t.result?.value))
await sleep(2500)

// 1. Open env panel
const env = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Toggle environment info"]')
  if (btn?.getAttribute('aria-pressed') !== 'true') btn?.click()
  return { ok: true }
})()`)
console.log('Env panel →', JSON.stringify(env.result?.value))
await sleep(800)
await snap('envinfo-redesign-01-default.png')

// 2. Click a change (the auto-open commit section is already visible)
const click = await evalExpr(`(() => {
  const aside = document.querySelector('aside[aria-label="Environmental Information"]')
  const headers = Array.from(aside.querySelectorAll('button'))
  const changesHeader = headers.find((b) => (b.textContent || '').trim().startsWith('Changes') && (b.textContent || '').length < 30)
  if (!changesHeader) return { ok: false, reason: 'no changes header' }
  // Make sure the section is open
  if (changesHeader.getAttribute('aria-expanded') === 'false') changesHeader.click()
  const section = changesHeader.parentElement
  const fileButtons = Array.from(section.querySelectorAll('button'))
    .filter((b) => b !== changesHeader)
  if (fileButtons.length === 0) return { ok: false, reason: 'no files' }
  const sorted = fileButtons.sort((a, b) => {
    const aIsText = /\.(txt|md|ts|tsx|js|jsx|json|css|scss|html|yml|yaml|xml|sh)\b/.test(a.textContent || '')
    const bIsText = /\.(txt|md|ts|tsx|js|jsx|json|css|scss|html|yml|yaml|xml|sh)\b/.test(b.textContent || '')
    if (aIsText && !bIsText) return -1
    if (!aIsText && bIsText) return 1
    return 0
  })
  sorted[0].click()
  return { ok: true, label: (sorted[0].textContent || '').trim().slice(0, 60) }
})()`)
console.log('First change →', JSON.stringify(click.result?.value))
await sleep(1500)
await snap('envinfo-redesign-02-diff.png')

// 3. Back
const back = await evalExpr(`document.querySelector('button[aria-label="Back to changes"]')?.click(); 'ok'`)
console.log('Back →', back.result?.value)
await sleep(500)
await snap('envinfo-redesign-03-list.png')

// 4. Toggle the Branch section to confirm accordion works
const toggle = await evalExpr(`(() => {
  const aside = document.querySelector('aside[aria-label="Environmental Information"]')
  const headers = Array.from(aside.querySelectorAll('button'))
  const branchHeader = headers.find((b) => (b.textContent || '').trim() === 'Branch')
  if (!branchHeader) return { ok: false, reason: 'no Branch header' }
  branchHeader.click()
  return { ok: true }
})()`)
console.log('Toggle branch →', JSON.stringify(toggle.result?.value))
await sleep(500)
await snap('envinfo-redesign-04-collapsed.png')

console.log('OK')
ws.close()
