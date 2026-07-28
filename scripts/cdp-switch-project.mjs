/** Find a registered project that is a git repo, switch to it, and snap
 *  the welcome context bar branch chip. */
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

// Probe every project for git branch
const probe = await evalExpr(`(async () => {
  const projects = await window.electronAPI.projects.list()
  const results = []
  for (const p of projects) {
    const r = await window.electronAPI.git.exec(p.id, ['branch', '--show-current'])
    results.push({ id: p.id, label: p.label, branch: r.ok ? r.stdout.trim() : null })
  }
  return results
})()`)
console.log('Probe →', JSON.stringify(probe.result?.value))

const withBranch = (probe.result?.value || []).find((p) => p.branch)
if (!withBranch) { console.log('No git project found'); process.exit(0) }

const sw = await evalExpr(`(async () => {
  await window.electronAPI.projects.setActive('${withBranch.id}')
  return { ok: true }
})()`)
console.log('Switch →', JSON.stringify(sw.result?.value), 'to', withBranch.label, '(' + withBranch.branch + ')')
await sleep(1500)

// Back to welcome
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  btn?.click()
})()`)
await sleep(1500)

const bar = await evalExpr(`(() => {
  const bar = document.querySelector('[data-context-bar]')
  if (!bar) return { ok: false }
  return { ok: true, labels: Array.from(bar.querySelectorAll('button')).map((b) => (b.textContent || '').trim()) }
})()`)
console.log('Context bar →', JSON.stringify(bar.result?.value))

const r = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(join(outDir, 'welcome-redesign-06-branch-chip.png'), Buffer.from(r.data, 'base64'))
console.log('Saved → welcome-redesign-06-branch-chip.png')

const b = await evalExpr(`(() => {
  const btn = document.querySelector('[data-context-bar] button[aria-label="Current branch"]')
  if (!btn) return { present: false }
  btn.click()
  return { present: true }
})()`)
console.log('Branch dropdown →', JSON.stringify(b.result?.value))
await sleep(600)
if (b.result?.value?.present) {
  const r2 = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, 'welcome-redesign-07-branch-open.png'), Buffer.from(r2.data, 'base64'))
  console.log('Saved → welcome-redesign-07-branch-open.png')
}
process.exit(0)
