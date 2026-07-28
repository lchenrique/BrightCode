/** Verify the picker now opens at provider step with all 5 groups. */
const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180'))
if (!page) { console.error('No main page'); process.exit(1) }

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

// WelcomeScreen
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  btn?.click()
})()`)
await sleep(1500)

// Open picker
await evalExpr(`document.querySelector('button[aria-label="Select model"]')?.click()`)
await sleep(1000)

// Read provider step items
const r = await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[data-picker-item]'))
  return {
    count: items.length,
    items: items.map((i) => (i.textContent || '').trim().slice(0, 60)),
  }
})()`)
console.log('PROVIDER STEP →', JSON.stringify(r.result?.value, null, 1))

// Optional: click first item to go to model step
if ((r.result?.value?.count || 0) > 0) {
  const sel = await evalExpr(`(() => {
    const items = Array.from(document.querySelectorAll('[data-picker-item]'))
    if (items[0]) { items[0].click(); return 'clicked' }
    return 'no items'
  })()`)
  console.log('CLICK FIRST →', sel.result?.value)
  await sleep(800)
  const r2 = await evalExpr(`(() => {
    const items = Array.from(document.querySelectorAll('[data-picker-item]'))
    return {
      count: items.length,
      items: items.map((i) => (i.textContent || '').trim().slice(0, 60)),
    }
  })()`)
  console.log('MODEL STEP →', JSON.stringify(r2.result?.value, null, 1))
}

process.exit(0)
