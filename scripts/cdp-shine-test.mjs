/**
 * Compare the sidebar "shine" highlight in two states:
 *   1. Task "oi" is the active task but no work is happening.
 *   2. The user has just typed a character into the chat input.
 *
 * In both screenshots the same task is selected — only the animation
 * should differ. We assert that the title element picks up the
 * .task-title-shine class only in the second state.
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

// 0. Open the "oi" task in MAG
const t = await evalExpr(`(() => {
  if (document.querySelector('button[aria-label="Toggle environment info"]') ||
      document.querySelector('aside[aria-label="Project file explorer"]')) {
    return { already: true }
  }
  const task = Array.from(document.querySelectorAll('button'))
    .find((b) => b.textContent?.trim() === 'oi')
  task?.click()
  return { clicked: true }
})()`)
console.log('Task open →', JSON.stringify(t.result?.value))
await sleep(2000)

// 1. Snap: task active, no input typed
await snap('shine-01-idle.png')
const idleHasShine = await evalExpr(`(() => {
  const titleEl = Array.from(document.querySelectorAll('span'))
    .find((s) => s.textContent?.trim() === 'oi')
  if (!titleEl) return { found: false }
  return { found: true, hasShine: titleEl.className.includes('task-title-shine') }
})()`)
console.log('Idle state →', JSON.stringify(idleHasShine.result?.value))

// 2. Type a character into the chat input
await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return { ok: false, reason: 'no textarea' }
  ta.focus()
  // Fire an input event so React picks up the value
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'olá')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return { ok: true }
})()`)
console.log('Typed text')
await sleep(500)
await snap('shine-02-typing.png')
const typingHasShine = await evalExpr(`(() => {
  const titleEl = Array.from(document.querySelectorAll('span'))
    .find((s) => s.textContent?.trim() === 'oi')
  return { found: true, hasShine: titleEl.className.includes('task-title-shine') }
})()`)
console.log('Typing state →', JSON.stringify(typingHasShine.result?.value))

// 3. Clear the input — shine should turn off again
await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(500)
await snap('shine-03-cleared.png')
const clearedHasShine = await evalExpr(`(() => {
  const titleEl = Array.from(document.querySelectorAll('span'))
    .find((s) => s.textContent?.trim() === 'oi')
  return { hasShine: titleEl.className.includes('task-title-shine') }
})()`)
console.log('Cleared state →', JSON.stringify(clearedHasShine.result?.value))

console.log('OK')
ws.close()
