/**
 * Screenshot the ProjectView with tool call + EditedFilesCard.
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

const testName = 'bc-pv-screenshot'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target + '/src')
  await window.electronAPI.tools.execute('write_file', { path: 'README.md', content: '# Sales Dashboard\\n\\nReal-time metrics for our store.\\n' })
  await window.electronAPI.tools.execute('write_file', { path: 'src/index.ts', content: 'export const hello = "world"\\n' })
  await window.electronAPI.tools.execute('write_file', { path: 'src/utils.ts', content: 'export function add(a: number, b: number) { return a + b }\\n' })
  await window.electronAPI.projects.add(target, '${testName}')
  return 'ok'
})()`)
console.log('Setup:', setup.result.value)
await new Promise(r => setTimeout(r, 600))

// Click the project
await evalExpr(`(() => {
  const btns = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
  btns.find(b => b.textContent?.includes('${testName}'))?.click()
  return 'ok'
})()`)
await new Promise(r => setTimeout(r, 800))

// Ask the agent to inspect the project files — should trigger read_file + list_files
await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'List all files in this project (use list_files with recursive=true), then read README.md and tell me what it says. Be brief.')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'ok'
})()`)

// Wait for the agent loop to finish (no spinner + at least 1 bubble + edited card if there are writes)
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const c = await evalExpr(`(() => {
    const sp = document.querySelector('.animate-pulse')
    const bubbles = Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
    const toolBubbles = Array.from(document.querySelectorAll('code.font-mono'))
    return JSON.stringify({ hasSpinner: sp !== null, count: bubbles.length, toolCount: toolBubbles.length })
  })()`)
  const v = JSON.parse(c.result.value)
  console.log(`[${i*2}s] bubbles=${v.count} tools=${v.toolCount} spinner=${v.hasSpinner}`)
  if (v.count > 0 && !v.hasSpinner) break
}

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs/promises')
const out = process.argv[2] || `${process.env.TEMP || '/tmp'}/brightcode-projectview.png`
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
