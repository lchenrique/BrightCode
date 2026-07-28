/** Measure the model-picker dropdown: provider step height vs item count. */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find((t) => t.type === 'page' && t.url && !t.url.includes('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res) => ws.addEventListener('open', res))
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable', {})
await send('Runtime.enable', {})

const outDir = join(process.cwd(), 'scripts', 'screenshots')
mkdirSync(outDir, { recursive: true })
async function snap(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('Saved →', name)
}

// Welcome screen
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  btn?.click()
})()`)
await sleep(1000)

// Force the PROVIDER step: clear last selection so picker opens at provider list.
// Open the picker
await evalExpr(`document.querySelector('button[aria-label="Select model"]')?.click()`)
await sleep(700)

// If it opened on the model step, go back to providers
await evalExpr(`(() => {
  const back = document.querySelector('button[aria-label="Back to providers"]')
  back?.click()
})()`)
await sleep(500)

const measure = await evalExpr(`(() => {
  const content = document.querySelector('[data-radix-popper-content-wrapper] > div')
  if (!content) return { ok: false, reason: 'no popover' }
  const items = Array.from(content.querySelectorAll('[data-picker-item]'))
  const rect = content.getBoundingClientRect()
  const styles = getComputedStyle(content)
  return {
    ok: true,
    popoverHeight: Math.round(rect.height),
    popoverWidth: Math.round(rect.width),
    itemCount: items.length,
    itemHeights: items.map((i) => Math.round(i.getBoundingClientRect().height)),
    labels: items.map((i) => (i.textContent || '').trim().slice(0, 40)),
    viewportH: window.innerHeight,
    maxH: styles.maxHeight,
  }
})()`)
console.log('PROVIDER STEP →', JSON.stringify(measure.result?.value, null, 1))
await snap('dropdown-01-provider-step.png')

// Now into the zen (or first provider) model step
await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[data-picker-item]'))
  items[0]?.click()
})()`)
await sleep(700)

const measure2 = await evalExpr(`(() => {
  const content = document.querySelector('[data-radix-popper-content-wrapper] > div')
  if (!content) return { ok: false, reason: 'no popover' }
  const items = Array.from(content.querySelectorAll('[data-picker-item]'))
  const rect = content.getBoundingClientRect()
  const scroller = content.querySelector('.overflow-y-auto')
  return {
    ok: true,
    popoverHeight: Math.round(rect.height),
    itemCount: items.length,
    itemHeights: items.slice(0, 5).map((i) => Math.round(i.getBoundingClientRect().height)),
    scrollH: scroller ? Math.round(scroller.getBoundingClientRect().height) : null,
    viewportH: window.innerHeight,
  }
})()`)
console.log('MODEL STEP →', JSON.stringify(measure2.result?.value, null, 1))
await snap('dropdown-02-model-step.png')

await evalExpr(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
console.log('DONE')
process.exit(0)
