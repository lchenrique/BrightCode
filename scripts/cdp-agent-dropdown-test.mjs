/**
 * Screenshot the new dropdown-based Create Agent modal in all states.
 *
 *   1. Open the modal — show the closed dropdown.
 *   2. Open the dropdown — show all 8 presets listed + Custom + Browse.
 *   3. Type in the search filter — narrow the list.
 *   4. Click "Reviewer" → form pre-fills with read-only tools.
 *   5. Open the dropdown again, click "Custom" — form clears.
 *   6. Re-open and verify the previous selection is restored.
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

// Open the modal
await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Add agent"]')
  if (!btn) return 'NO BUTTON'
  btn.click()
  return 'clicked'
})()`)
await sleep(400)
await snap('agent-dropdown-01-closed.png')

// Open the dropdown
const opened = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Pick agent source"]')
  if (!btn) return 'NO BUTTON'
  btn.click()
  return 'clicked'
})()`)
console.log('Open dropdown →', opened.result.value)
await sleep(500)

const state = await evalExpr(`(() => {
  // Radix popover renders in a portal; we look for any popover content.
  const popovers = document.querySelectorAll('[role="dialog"]')
  // The popover doesn't use role=dialog, so search by content shape.
  const list = Array.from(document.querySelectorAll('button')).filter(b => {
    const t = b.textContent || ''
    return t.includes('Custom') || t.includes('Browse') || t.includes('Backend Architect') || t.includes('Frontend React') || t.includes('Reviewer') || t.includes('API Tester') || t.includes('Planner') || t.includes('Git Workflow') || t.includes('Reality Checker') || t.includes('Product Manager')
  })
  return JSON.stringify({ count: list.length, labels: list.map(b => (b.textContent || '').slice(0, 50)) })
})()`)
console.log('Dropdown state →', state.result.value)
await snap('agent-dropdown-02-open.png')

// Type into the search
await evalExpr(`(() => {
  const search = document.querySelector('input[placeholder="Search presets…"]')
  if (!search) return 'NO SEARCH'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(search, 'rev')
  search.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed'
})()`)
await sleep(300)
await snap('agent-dropdown-03-search-rev.png')

// Click Reviewer
await evalExpr(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const target = buttons.find(b => b.textContent?.includes('Reviewer'))
  if (!target) return 'NO REVIEWER'
  target.click()
  return 'clicked'
})()`)
await sleep(400)
await snap('agent-dropdown-04-reviewer-filled.png')

const filled = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  const name = (d.querySelector('#create-agent-name'))?.value ?? ''
  const desc = (d.querySelector('#create-agent-description'))?.value ?? ''
  const prompt = (d.querySelector('#create-agent-system-prompt'))?.value ?? ''
  // Find the tools-allowed line (after the prompt textarea)
  const toolLine = d.querySelector('code')?.parentElement?.textContent ?? ''
  return JSON.stringify({ name, desc, promptLen: prompt.length, toolLine: toolLine.slice(0, 200) })
})()`)
console.log('Reviewer filled →', filled.result.value)

// Open dropdown again, switch to Custom
await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Pick agent source"]')
  if (btn) btn.click()
})()`)
await sleep(300)
await evalExpr(`(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
  const custom = buttons.find(b => (b.textContent || '').trim().startsWith('Custom'))
  if (!custom) return 'NO CUSTOM'
  custom.click()
  return 'clicked'
})()`)
await sleep(300)
await snap('agent-dropdown-05-custom.png')

const afterCustom = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return 'NO DIALOG'
  const name = (d.querySelector('#create-agent-name'))?.value ?? ''
  const prompt = (d.querySelector('#create-agent-system-prompt'))?.value ?? ''
  return JSON.stringify({ name, promptLen: prompt.length })
})()`)
console.log('After Custom click →', afterCustom.result.value)

// Verify the previous preset content doesn't leak to the next open
await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  const close = d?.querySelector('[aria-label="Close"]')
  if (close) close.click()
  return 'closed'
})()`)
await sleep(300)
await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Add agent"]')
  if (btn) btn.click()
})()`)
await sleep(400)
const reopened = await evalExpr(`(() => {
  const d = document.querySelector('[role="dialog"]')
  if (!d) return JSON.stringify({ open: false })
  const name = (d.querySelector('#create-agent-name'))?.value ?? ''
  const prompt = (d.querySelector('#create-agent-system-prompt'))?.value ?? ''
  return JSON.stringify({ open: true, name, promptLen: prompt.length })
})()`)
console.log('Re-opened →', reopened.result.value)
await snap('agent-dropdown-06-reopened-clean.png')

ws.close()
process.exit(0)
