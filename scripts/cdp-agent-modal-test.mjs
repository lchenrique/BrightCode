/**
 * Screenshot the new tabbed Create Agent modal in all three states.
 *
 *   1. Click the "+" button in the Agent Team section of the sidebar.
 *   2. Capture the default Preset tab.
 *   3. Click a preset → form pre-fills.
 *   4. Switch to From file tab.
 *   5. Switch to Custom tab.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('No page target at', HOST); process.exit(1) }

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
  if (r.error) { console.error('captureScreenshot failed', r.error); return }
  writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('Saved →', join(outDir, name))
}

await sleep(800)

// Open the create-agent modal by clicking the + button in Agent Team
const open = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Add agent"]')
  if (!btn) return 'NO BUTTON'
  btn.click()
  return 'clicked'
})()`)
console.log('Open modal →', open.result.value)
await sleep(400)

const dialog = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return JSON.stringify({ open: false })
  const tabs = Array.from(d.querySelectorAll('button[role="tab"]')).map(t => t.textContent?.trim())
  return JSON.stringify({ open: true, tabs })
})()`)
console.log('Dialog state →', dialog.result.value)
if (!JSON.parse(dialog.result.value).open) {
  console.error('FAIL: dialog did not open')
  process.exit(1)
}

await snap('agent-01-preset-default.png')

// Click the Frontend preset (or whichever is not auto-selected first)
const clickPreset = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  // Find a button whose text contains "Frontend"
  const buttons = Array.from(d.querySelectorAll('button'))
  const target = buttons.find(b => b.textContent?.includes('Frontend'))
  if (!target) return 'NO PRESET BUTTON'
  target.click()
  return 'clicked'
})()`)
console.log('Click Frontend preset →', clickPreset.result.value)
await sleep(500)

const filled = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  const name = (d.querySelector('#create-agent-name'))?.value ?? ''
  const desc = (d.querySelector('#create-agent-description'))?.value ?? ''
  const prompt = (d.querySelector('#create-agent-system-prompt'))?.value ?? ''
  return JSON.stringify({ name, desc, promptLen: prompt.length })
})()`)
console.log('Form filled →', filled.result.value)

await snap('agent-02-preset-frontend-filled.png')

// Switch to "From file" tab
await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  const tab = Array.from(d.querySelectorAll('button[role="tab"]')).find(b => b.textContent?.trim() === 'From file')
  if (!tab) return 'NO TAB'
  tab.click()
  return 'clicked'
})()`)
await sleep(300)
await snap('agent-03-from-file-tab.png')

// Switch to "Custom" tab
await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  const tab = Array.from(d.querySelectorAll('button[role="tab"]')).find(b => b.textContent?.trim() === 'Custom')
  if (!tab) return 'NO TAB'
  tab.click()
  return 'clicked'
})()`)
await sleep(300)
await snap('agent-04-custom-tab.png')

// Close the modal
await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  const close = d.querySelector('[aria-label="Close"]')
  if (close) close.click()
  return 'closed'
})()`)
await sleep(300)

// Verify that the form values from the preset don't leak to the next open
const reopened = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Add agent"]')
  if (!btn) return 'NO BUTTON'
  btn.click()
  return 'clicked'
})()`)
console.log('Re-open →', reopened.result.value)
await sleep(400)
const afterReopen = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return JSON.stringify({ open: false })
  const name = (d.querySelector('#create-agent-name'))?.value ?? ''
  const prompt = (d.querySelector('#create-agent-system-prompt'))?.value ?? ''
  return JSON.stringify({ open: true, name, promptLen: prompt.length })
})()`)
console.log('After re-open →', afterReopen.result.value)
if (JSON.parse(afterReopen.result.value).name !== '') {
  console.error('FAIL: form not reset on close (name still:', JSON.parse(afterReopen.result.value).name, ')')
  process.exit(1)
}
await snap('agent-05-reopened-clean.png')

// Close
await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const close = d?.querySelector('[aria-label="Close"]')
  if (close) close.click()
  return 'closed'
})()`)

ws.close()
process.exit(0)
