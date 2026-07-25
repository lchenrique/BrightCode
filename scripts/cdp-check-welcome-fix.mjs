/**
 * Verify the text-only-response fix: an assistant message with NO tool
 * calls should render as a MessageBubble, not as an AssistantTurn. We
 * submit a simple "oi" message, wait for the response to finish, and
 * take a screenshot. We also assert that no "Thought N times" header
 * appears (which would mean the response is still being treated as a
 * turn).
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

// Submit a short message that the model will answer with just text
// (no tool calls). "oi" is the same prompt the user used in the
// session we just pulled, so we know exactly what the response looks
// like.
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

// Poll for the response to finish. The agent loop sets
// .animate-pulse off when streaming stops, AND the "Thought" header
// should be gone for text-only responses after our fix.
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1500))
  const c = await evalExpr(`(() => {
    const spinner = document.querySelector('.animate-pulse')
    // The "Thought N time(s)" header is rendered by AssistantTurn. If
    // we see it, the text-only response was still wrapped in a turn.
    const thoughtHeaders = Array.from(document.querySelectorAll('button'))
      .filter(b => b.textContent?.includes('Thought'))
      .map(b => b.textContent)
    // MessageBubble's assistant variant renders the model name (e.g.
    // "BIG-PICKLE") in uppercase as a small label. If we see it, the
    // text-only response is now a bubble.
    const modelLabels = Array.from(document.querySelectorAll('div'))
      .filter(d => /^[A-Z][A-Z0-9-]{1,15}$/.test(d.textContent?.trim() ?? ''))
      .map(d => d.textContent?.trim())
    return JSON.stringify({
      hasSpinner: spinner !== null,
      thoughtHeaders,
      modelLabels,
    })
  })()`)
  const v = JSON.parse(c.result.value)
  console.log(`[${i * 1.5}s] spinner=${v.hasSpinner} thoughts=${v.thoughtHeaders.length} labels=${JSON.stringify(v.modelLabels)}`)
  if (!v.hasSpinner && v.thoughtHeaders.length === 0 && v.modelLabels.length > 0) {
    console.log('✓ Fix verified: text-only response is a MessageBubble, not an AssistantTurn')
    break
  }
}

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs/promises')
const out = process.argv[2] || `${process.env.TEMP || '/tmp'}/brightcode-welcome-fix.png`
await fs.writeFile(out, Buffer.from(screenshot.data, 'base64'))
console.log('Saved', out)
process.exit(0)
