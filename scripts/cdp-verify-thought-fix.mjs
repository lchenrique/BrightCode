/**
 * Verify the new "turn + text-bubble-below" design. After the fix:
 *   1. An assistant message ALWAYS renders as an AssistantTurn
 *      ("Thought N time(s)" header).
 *   2. The text response renders as a separate MessageBubble BELOW
 *      the turn, in compact mode (no model label).
 *
 * Setup: send a simple "oi" in the current chat, wait for the
 * response, then take a screenshot.
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
await new Promise(r => setTimeout(r, 800))

// Click "New task" so we get the welcome state with the input
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent?.trim() === 'New task' || b.textContent?.includes('New task'))
  btn?.click()
  return 'clicked'
})()`)
await new Promise(r => setTimeout(r, 600))

// Send a simple "oi" — should produce a text-only response
await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'oi')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'submitted'
})()`)
console.log('Submitted "oi"')

// Wait for the response to finish
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1500))
  const c = await evalExpr(`(() => {
    const spinner = document.querySelector('.animate-pulse')
    const thoughtHeaders = Array.from(document.querySelectorAll('button'))
      .filter(b => b.textContent?.match(/^Thought \d+ time/))
      .map(b => b.textContent)
    return JSON.stringify({
      hasSpinner: spinner !== null,
      thoughtHeaders,
    })
  })()`)
  const v = JSON.parse(c.result.value)
  console.log(`[${i * 1.5}s] spinner=${v.hasSpinner} thoughts=${v.thoughtHeaders.length} (${JSON.stringify(v.thoughtHeaders)})`)
  if (!v.hasSpinner && v.thoughtHeaders.length > 0) {
    console.log('✓ Turn is present after response finished — fix verified!')
    break
  }
}

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs/promises')
const out = process.argv[2] || `${process.env.TEMP || '/tmp'}/brightcode-thought-fix.png`
await fs.writeFile(out, Buffer.from(screenshot.data, 'base64'))
console.log('Saved', out)
process.exit(0)
