/**
 * Screenshot the new Account tab in Settings.
 *
 *   1. Open Settings dialog (click the user card).
 *   2. Click the "Account" nav item.
 *   3. Snap the panel.
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

await sleep(800)

// 0. Click the user card in the sidebar (opens Settings)
const clickUser = await evalExpr(`(() => {
  const card = Array.from(document.querySelectorAll('button, [role="button"]'))
    .find((b) => b.textContent?.includes('Carlos Henrique'))
  if (!card) return { ok: false, reason: 'no user card' }
  card.click()
  return { ok: true }
})()`)
console.log('Open settings →', JSON.stringify(clickUser.result?.value))
await sleep(700)
await snap('account-settings-01-general.png')

// 1. Click "Account" nav
const clickAccount = await evalExpr(`(() => {
  const nav = Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === 'Account')
  if (!nav) return { ok: false }
  nav.click()
  return { ok: true }
})()`)
console.log('Account tab →', JSON.stringify(clickAccount.result?.value))
await sleep(500)
await snap('account-settings-02-account.png')

// 2. Other tabs
const clickAppearance = await evalExpr(`(() => {
  const nav = Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === 'Appearance')
  if (!nav) return { ok: false }
  nav.click()
  return { ok: true }
})()`)
console.log('Appearance tab →', JSON.stringify(clickAppearance.result?.value))
await sleep(500)
await snap('account-settings-03-appearance.png')

const clickUsage = await evalExpr(`(() => {
  const nav = Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === 'Usage & model')
  if (!nav) return { ok: false }
  nav.click()
  return { ok: true }
})()`)
console.log('Usage tab →', JSON.stringify(clickUsage.result?.value))
await sleep(500)
await snap('account-settings-04-usage.png')

console.log('OK')
ws.close()
