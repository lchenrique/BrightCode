/**
 * Polish visual check: tool rows show the actual error reason (not just
 * "failed") and the timeline updates correctly during a multi-tool run.
 *
 *   1. Set up project with one file.
 *   2. Fire bash with a command that will FAIL after approval — e.g.
 *      `node -e "process.exit(7)"`. Approve.
 *   3. Capture screenshot of the timeline showing the failed result
 *      with the actual reason (exit code 7), not just "failed".
 *   4. Fire another bash with a valid command and capture the timeline
 *      showing the success summary.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('No page target at', HOST); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await send('Page.enable', {})
await send('Runtime.enable', {})

const outDir = join(process.cwd(), 'scripts', 'screenshots')
mkdirSync(outDir, { recursive: true })

async function snap(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.error) { console.error('captureScreenshot failed', r.error); return }
  writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('Saved →', join(outDir, name))
}

const testName = 'bc-polish-test'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target)
  const r = await window.electronAPI.projects.add(target, '${testName}')
  await window.electronAPI.projects.setActive(r.project.id)
  await new Promise(res => setTimeout(res, 500))
  const w = await window.electronAPI.tools.execute('write_file', { path: 'README.md', content: 'polish test\\n' })
  return JSON.stringify({ projectId: r.project.id, writeFile: w })
})()`)
console.log('Setup →', setup.result.value)
await sleep(800)

// ── Test 1: bash that fails with non-zero exit ─────────────────────────
const failPromise = evalExpr(`(async () => {
  try {
    const r = await window.electronAPI.tools.execute('bash', { command: 'node -e "process.exit(7)"' })
    return JSON.stringify(r)
  } catch (e) {
    return 'THROW: ' + (e && e.message)
  }
})()`)
for (let i = 0; i < 30; i++) { await sleep(150); if ((await findDialog()).open) break }
await clickButton('Approve')
const failResult = JSON.parse((await failPromise).result.value)
console.log('Fail result →', JSON.stringify(failResult, null, 2))

// ── Test 2: bash that succeeds ─────────────────────────────────────────
const okPromise = evalExpr(`(async () => {
  try {
    const r = await window.electronAPI.tools.execute('bash', { command: 'node -p "process.pid"' })
    return JSON.stringify(r)
  } catch (e) {
    return 'THROW: ' + (e && e.message)
  }
})()`)
for (let i = 0; i < 30; i++) { await sleep(150); if ((await findDialog()).open) break }
await snap('polish-01-modal-success-pending.png')
await clickButton('Approve')
const okResult = JSON.parse((await okPromise).result.value)
console.log('OK result →', JSON.stringify(okResult, null, 2))
await sleep(500)
await snap('polish-02-after-approve.png')

// Verify the fail result envelope: should have ok:false, error containing exit code
if (failResult.ok === false && String(failResult.error).includes('7')) {
  console.log('✓ Failed command envelope is correct (error contains exit code 7)')
} else {
  console.log('✗ Unexpected fail envelope:', failResult)
}
if (okResult.ok === true && okResult.result.exitCode === 0) {
  console.log('✓ Successful command envelope is correct (exitCode 0)')
} else {
  console.log('✗ Unexpected ok envelope:', okResult)
}

// Cleanup
const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('Cleanup →', cleanup.result.value)
ws.close()
process.exit(0)

async function findDialog() {
  const r = await evalExpr(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return JSON.stringify({ open: false })
    const pre = dialog.querySelector('pre')
    const buttons = Array.from(dialog.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
    return JSON.stringify({ open: true, command: pre?.textContent ?? null, buttons })
  })()`)
  return JSON.parse(r.result.value)
}
async function clickButton(label) {
  const r = await evalExpr(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return 'NO DIALOG'
    const btn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.trim() === ${JSON.stringify(label)})
    if (!btn) return 'NO BUTTON'
    btn.click()
    return 'clicked'
  })()`)
  return r.result.value
}
