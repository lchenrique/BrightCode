/**
 * Visual test for the bash approval modal — renderer-side only.
 *
 *   1. Trigger `tools.execute('bash', ...)` via the existing IPC bridge.
 *   2. Wait for the modal to appear in the DOM.
 *   3. Capture a renderer screenshot via Page.captureScreenshot.
 *   4. Click "Deny" — capture the post-deny state.
 *   5. Trigger again, click "Approve" — capture the running state.
 *   6. Save 3 screenshots to disk and print paths.
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await send('Page.enable', {})
await send('Runtime.enable', {})

const outDir = join(process.cwd(), 'scripts', 'screenshots')
mkdirSync(outDir, { recursive: true })

async function snap(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.error) { console.error('captureScreenshot failed', r.error); return }
  const data = r.data
  const file = join(outDir, name)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log('Saved →', file)
}

async function evalExpr(expression) {
  return await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
}

async function findDialogState() {
  const r = await evalExpr(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return JSON.stringify({ open: false })
    const pre = dialog.querySelector('pre')
    const buttons = Array.from(dialog.querySelectorAll('button'))
      .map(b => b.textContent?.trim())
      .filter(Boolean)
    return JSON.stringify({
      open: true,
      command: pre?.textContent ?? null,
      buttons,
    })
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

// Pick a free project path so we can call the tool from the renderer.
const testName = 'bc-bash-visual'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target)
  const r = await window.electronAPI.projects.add(target, '${testName}')
  await window.electronAPI.projects.setActive(r.project.id)
  // Give the main process time to settle the active project.
  await new Promise(r => setTimeout(r, 500))
  const active = await window.electronAPI.projects.getActive()
  return JSON.stringify({ target, projectId: r.project.id, active: active && { id: active.id, label: active.label } })
})()`)
console.log('Setup →', setup.result.value)
await sleep(800)

// Screenshot 1: the welcome view baseline
await snap('bash-01-welcome.png')

// Fire bash — the modal should pop up.
const denyPromise = evalExpr(`(async () => {
  try {
    const r = await window.electronAPI.tools.execute('bash', { command: 'git status && echo "this would run if approved"' })
    return JSON.stringify(r)
  } catch (e) {
    return 'THROW: ' + (e && e.message)
  }
})()`)
// Wait for modal
let state
for (let i = 0; i < 30; i++) {
  await sleep(150)
  state = await findDialogState()
  if (state.open) break
}
console.log('Modal state →', state)
if (!state.open) {
  const stillPending = await evalExpr(`(async () => {
    const r = await window.electronAPI.tools.execute('bash', { command: 'echo probe' }).catch(e => 'THROW: ' + e.message)
    return JSON.stringify(r)
  })()`)
  console.log('Direct call result (after timeout) →', stillPending.result.value)
  // Cancel any pending call so the script can exit
  process.exit(1)
}

// Screenshot 2: the modal in the deny run
await snap('bash-02-modal-pending.png')

const denyClick = await clickButton('Deny')
console.log('Click Deny →', denyClick)
const denyResult = JSON.parse((await denyPromise).result.value)
console.log('Deny result →', JSON.stringify(denyResult))
if (denyResult.ok !== false) { console.error('FAIL: deny did not return ok=false'); process.exit(1) }
await sleep(400)

// Fire bash again for the approve run.
const approvePromise = evalExpr(`(async () => {
  try {
    const r = await window.electronAPI.tools.execute('bash', { command: 'node -p "Math.random()"' })
    return JSON.stringify(r)
  } catch (e) {
    return 'THROW: ' + (e && e.message)
  }
})()`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  state = await findDialogState()
  if (state.open) break
}
if (!state.open) { console.error('FAIL: modal did not appear (approve)'); process.exit(1) }

// Screenshot 3: modal in the approve run
await snap('bash-03-modal-approve.png')

const approveClick = await clickButton('Approve')
console.log('Click Approve →', approveClick)
const approveResult = JSON.parse((await approvePromise).result.value)
console.log('Approve result →', JSON.stringify(approveResult, null, 2))
if (approveResult.ok !== true) { console.error('FAIL: approve did not run command'); process.exit(1) }
await sleep(500)

// Screenshot 4: the chat with the bash result (best-effort)
await snap('bash-04-after-approve.png')

// Cleanup
const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('Cleanup →', cleanup.result.value)

console.log('\nAll bash visual checks passed.')
ws.close()
process.exit(0)
