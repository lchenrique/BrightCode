/**
 * End-to-end smoke: create a test project, send "estamos em q pasta?",
 * and capture the assistant's response. Validates that the active-project
 * path is actually being injected into the system prompt.
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) {
  console.error('No renderer page found')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result || msg.error)
    pending.delete(msg.id)
  }
})
const send = (method, params) => {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((res) => pending.set(mid, res))
}

const evalExpr = (expression, awaitPromise = false) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })

await send('Runtime.enable', {})
await new Promise((r) => setTimeout(r, 1500))

// ── 1. Make sure a project exists and is active ──────────────────────
const testName = 'bc-system-prompt-test'

const setup = await evalExpr(`(async () => {
  // Clean up old test if any
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  // Add fresh
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  const r1 = await window.electronAPI.fs.createDir(target)
  const r2 = await window.electronAPI.projects.add(target, '${testName}')
  return JSON.stringify({ setup: r1, add: r2, dir: target })
})()`, true)
console.log('Setup →', setup.result.value)
await new Promise((r) => setTimeout(r, 1000))

// ── 2. Read the systemPrompt we build ───────────────────────────────
const sysPrompt = await evalExpr(`(async () => {
  const mod = await import('/src/lib/agents/system-prompt.ts')
  return mod.buildSystemPrompt({ project: await window.electronAPI.projects.getActive() })
})()`, true)
console.log('\n=== System prompt the agent sees ===')
console.log(sysPrompt.result.value)

// ── 3. Type "estamos em q pasta?" and submit ─────────────────────────
const userQuestion = 'estamos em q pasta? Responda em uma frase curta.'

const submit = await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return 'NO TEXTAREA'
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(userQuestion)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new Event('change', { bubbles: true }))
  ta.focus()
  // The ChatInput usually submits on Enter (without shift) — dispatch
  // a KeyboardEvent so the React handler fires.
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  ta.dispatchEvent(ev)
  return 'submitted'
})()`)
console.log('\nSubmit →', submit.result.value)

// ── 4. Wait for the response to land ─────────────────────────────────
await new Promise((r) => setTimeout(r, 8000))

const response = await evalExpr(`(() => {
  const bubbles = Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
  return JSON.stringify(bubbles.map(b => b.textContent?.trim()).filter(Boolean))
})()`)
console.log('\n=== Assistant bubbles ===')
console.log(response.result.value)

// ── 5. Cleanup ───────────────────────────────────────────────────────
const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`, true)
console.log('\nCleanup →', cleanup.result.value)

process.exit(0)
