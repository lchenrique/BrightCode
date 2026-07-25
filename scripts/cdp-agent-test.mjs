/**
 * End-to-end agent test v2: capture console logs, wait longer, dump DOM.
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) { console.error('No page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
const consoleLogs = []
const exceptions = []
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
  if (msg.method === 'Runtime.consoleAPICalled') consoleLogs.push(msg.params)
  if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails)
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 1500))

const testName = 'bc-agent-test2'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target)
  await window.electronAPI.tools.execute('write_file', {
    path: 'README.md',
    content: '# BrightCode Agent Test\\n\\nThe magic number is 1337. Find this marker.\\n'
  })
  await window.electronAPI.projects.add(target, '${testName}')
  return 'ok'
})()`)
console.log('Setup →', setup.result.value)
await new Promise(r => setTimeout(r, 600))

const question = 'Use your read_file tool to open README.md and tell me the magic number. Reply in one sentence.'
const submit = await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return 'NO TEXTAREA'
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, ${JSON.stringify(question)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
  ta.dispatchEvent(ev)
  return 'submitted'
})()`)
console.log('\nSubmit →', submit.result.value)

// Poll for completion (look for !streaming bubble)
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const check = await evalExpr(`(() => {
    const bubbles = Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
    const assistantText = bubbles.map(b => b.textContent?.trim()).filter(Boolean)
    const hasSpinner = document.querySelector('.animate-pulse') !== null
    return JSON.stringify({ count: assistantText.length, text: assistantText.slice(0, 5), hasSpinner })
  })()`)
  const c = JSON.parse(check.result.value)
  console.log(`[${i*2}s] bubbles=${c.count} hasSpinner=${c.hasSpinner} text=${JSON.stringify(c.text).slice(0, 120)}`)
  if (c.count > 0 && !c.hasSpinner) break
}

console.log('\n=== Console logs (last 30) ===')
for (const log of consoleLogs.slice(-30)) {
  const text = (log.args || []).map(a => a.value ?? a.description ?? '').join(' ')
  console.log(`[${log.type}] ${text.slice(0, 200)}`)
}

console.log('\n=== Exceptions ===')
for (const e of exceptions) {
  console.log(JSON.stringify(e).slice(0, 400))
}

const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('\nCleanup →', cleanup.result.value)
process.exit(0)
