/**
 * Screenshot the chat with a tool call visible.
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

const testName = 'bc-screenshot-agent'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target)
  await window.electronAPI.tools.execute('write_file', {
    path: 'README.md',
    content: '# BrightCode Agent Test\\n\\nThe magic number is 1337.\\n'
  })
  await window.electronAPI.projects.add(target, '${testName}')
  return 'ok'
})()`)
await new Promise(r => setTimeout(r, 600))

const submit = await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'Read README.md with your read_file tool and tell me the magic number inside. One sentence.')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'ok'
})()`)
console.log('Submit:', submit.result.value)

// Wait for the response to land
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const c = await evalExpr(`(() => {
    const bubbles = Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
    const sp = document.querySelector('.animate-pulse')
    return JSON.stringify({ count: bubbles.length, hasSpinner: sp !== null, text: bubbles.map(b => b.textContent?.trim()).filter(Boolean) })
  })()`)
  const v = JSON.parse(c.result.value)
  if (v.count > 0 && !v.hasSpinner) break
}

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs/promises')
const out = process.argv[2] || `${process.env.TEMP || '/tmp'}/brightcode-agent.png`
await fs.writeFile(out, Buffer.from(screenshot.data, 'base64'))
console.log('Saved', out)

const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('Cleanup:', cleanup.result.value)
process.exit(0)
