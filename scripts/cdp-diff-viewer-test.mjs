/**
 * Screenshot the diff viewer in EnvironmentalInfoPanel.
 *
 *   1. Open the task "oi" (MAG project) from the sidebar.
 *   2. Toggle the env-info right panel.
 *   3. Click the first change in the list.
 *   4. Switch to unified mode.
 *   5. Switch back to split.
 *   6. Back to list.
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

// 0. Open task "oi" if not already in a task
const taskClick = await evalExpr(`(() => {
  // Check if env button exists (= we're in a task)
  if (document.querySelector('button[aria-label="Toggle environment info"]')) {
    return { already: true }
  }
  // Otherwise, click the "oi" task in the sidebar
  const btns = Array.from(document.querySelectorAll('button'))
  const task = btns.find((b) => b.textContent && b.textContent.trim() === 'oi')
  if (!task) return { ok: false, reason: 'no task' }
  task.click()
  return { clicked: true }
})()`)
console.log('Task open →', JSON.stringify(taskClick.result?.value))
await sleep(2500)
await snap('diff-viewer-01-env-panel-initial.png')

// 1. Toggle the env panel
const envClick = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Toggle environment info"]')
  if (!btn) return { ok: false, reason: 'no env button' }
  const isOpen = btn.getAttribute('aria-pressed') === 'true'
  if (!isOpen) btn.click()
  return { ok: true, wasOpen: isOpen }
})()`)
console.log('Env panel →', JSON.stringify(envClick.result?.value))
await sleep(700)
await snap('diff-viewer-02-env-panel.png')

// 2. Click the first change (prefer text files so the DiffView renders properly)
const firstChange = await evalExpr(`(() => {
  const aside = document.querySelector('aside[aria-label="Environmental Information"]')
  if (!aside) return { ok: false, reason: 'no aside' }
  // Find the section titled "Changes" and click the first file button inside
  const sectionHeaders = Array.from(aside.querySelectorAll('button'))
  const changesHeader = sectionHeaders.find((b) => {
    const t = (b.textContent || '').trim()
    return t.startsWith('Changes') && t.length < 30
  })
  if (!changesHeader) return { ok: false, reason: 'no Changes section' }
  // The section wrapper is its parent. Find the first file button inside.
  const section = changesHeader.parentElement
  if (!section) return { ok: false, reason: 'no section parent' }
  // The file list sits in the next sibling of the header button.
  const fileButtons = Array.from(section.querySelectorAll('button'))
    .filter((b) => b !== changesHeader)
  if (fileButtons.length === 0) return { ok: false, reason: 'no files', count: fileButtons.length }
  // Sort: prefer text-like extensions
  const sorted = fileButtons.sort((a, b) => {
    const aText = a.textContent || ''
    const bText = b.textContent || ''
    const aIsText = /\.(txt|md|ts|tsx|js|jsx|json|css|scss|html|yml|yaml|xml|sh)\b/.test(aText)
    const bIsText = /\.(txt|md|ts|tsx|js|jsx|json|css|scss|html|yml|yaml|xml|sh)\b/.test(bText)
    if (aIsText && !bIsText) return -1
    if (!aIsText && bIsText) return 1
    return 0
  })
  const changeBtn = sorted[0]
  changeBtn.click()
  return { ok: true, label: (changeBtn.textContent || '').trim().slice(0, 60) }
})()`)
console.log('First change →', JSON.stringify(firstChange.result?.value))
await sleep(1500)
await snap('diff-viewer-03-split.png')

// 3. Switch to unified
const unified = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Unified view"]')
  if (!btn) return { ok: false }
  btn.click()
  return { ok: true }
})()`)
console.log('Unified →', JSON.stringify(unified.result?.value))
await sleep(700)
await snap('diff-viewer-04-unified.png')

// 4. Back to split
const split = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Split view"]')
  if (!btn) return { ok: false }
  btn.click()
  return { ok: true }
})()`)
console.log('Split →', JSON.stringify(split.result?.value))
await sleep(500)
await snap('diff-viewer-05-split-again.png')

// 5. Back to list
const back = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Back to changes"]')
  if (!btn) return { ok: false }
  btn.click()
  return { ok: true }
})()`)
console.log('Back →', JSON.stringify(back.result?.value))
await sleep(500)
await snap('diff-viewer-06-list.png')

console.log('OK')
ws.close()
