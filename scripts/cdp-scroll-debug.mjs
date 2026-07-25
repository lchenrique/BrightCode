/**
 * Inject many user messages, then dump the scroll container's geometry
 * to find out whether the issue is CSS sizing, missing overflow, or
 * something inside the chat component itself.
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) { console.error('No page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 1500))

// Make sure there's an active project (needed for tool calls, but we won't
// trigger any here)
await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  if (list.length === 0) {
    const dir = await window.electronAPI.fs.defaultProjectsDir()
    await window.electronAPI.fs.createDir(dir + '/bc-scroll-test')
    await window.electronAPI.projects.add(dir + '/bc-scroll-test', 'bc-scroll-test')
  }
  return 'ok'
})()`)
await new Promise(r => setTimeout(r, 500))

// Submit a single short question (no tool calls, just text) so the chat
// becomes the "messages" view and we have something to scroll.
const submit = await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'Write a long essay about TypeScript generics, with at least 20 numbered points. Each point should be 2-3 sentences long. Be thorough.')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'ok'
})()`)
console.log('Submit:', submit.result.value)

// Wait for completion
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const c = await evalExpr(`(() => {
    const sp = document.querySelector('.animate-pulse')
    const bubbles = Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
    return JSON.stringify({ hasSpinner: sp !== null, count: bubbles.length })
  })()`)
  const v = JSON.parse(c.result.value)
  if (!v.hasSpinner && v.count > 0) {
    console.log(`Done at ${i*2}s with ${v.count} bubble(s)`)
    break
  }
}

// Inspect the scroll container hierarchy
const inspect = await evalExpr(`(() => {
  function describe(el) {
    if (!el) return null
    const cs = getComputedStyle(el)
    return {
      tag: el.tagName,
      classes: el.className,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      offsetHeight: el.offsetHeight,
      overflow: cs.overflow + ' / ' + cs.overflowY,
      height: cs.height,
      flex: cs.flex,
    }
  }
  // Find candidates: the message list is the only .overflow-y-auto inside main
  const main = document.querySelector('main')
  const scrollEls = Array.from(document.querySelectorAll('main *')).filter(el => {
    const cs = getComputedStyle(el)
    return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
  })
  return JSON.stringify({
    main: describe(main),
    scrollCandidates: scrollEls.map(describe),
    bodyHeight: document.body.clientHeight,
    viewportHeight: window.innerHeight,
  }, null, 2)
})()`)
console.log('\n=== Scroll container hierarchy ===')
console.log(inspect.result.value)

// Try to scroll it manually
const manual = await evalExpr(`(() => {
  const scrollEls = Array.from(document.querySelectorAll('main *')).filter(el => {
    const cs = getComputedStyle(el)
    return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
  })
  if (scrollEls.length === 0) return JSON.stringify({ scrolled: false, reason: 'no overflow-y element found' })
  const el = scrollEls[0]
  el.scrollTop = 0
  const top = el.scrollTop
  el.scrollTop = el.scrollHeight
  const after = el.scrollTop
  return JSON.stringify({ scrolled: true, topAtStart: top, topAtEnd: after, maxScroll: el.scrollHeight - el.clientHeight, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })
})()`)
console.log('\n=== Manual scroll test ===')
console.log(manual.result.value)

process.exit(0)
