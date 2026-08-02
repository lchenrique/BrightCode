import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * End-to-end test for the bash tool + approval modal.
 *
 *   1. Select an existing project and remember the original selection.
 *   2. Fire `tools.execute('bash', ...)` — main process emits the
 *      approval event; the BashApprovalDialog should appear with the
 *      exact command rendered.
 *   3. Click "Deny" — expect `{ ok: false, error: 'User denied...' }`.
 *   4. Fire the tool again — click "Approve" — expect the command to
 *      run, stdout/stderr/exitCode/durationMs to come back.
 *   5. Cwd behavior: an explicitly approved `cd ..` may leave the
 *      initial project cwd; verify it runs without crashing.
 *   6. Cleanup.
 */

const HOST = 'http://localhost:9222'
const PROJECT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'dev'
const expectedScheme = mode === 'packaged' ? 'file://' : 'http://localhost'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.title === 'BrightCode' && t.url.startsWith(expectedScheme))
if (!page) { console.error(`No BrightCode ${mode} page; expected ${expectedScheme}`); throw new Error('Bash approval smoke failed') }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await send('Runtime.enable', {})
await sleep(1200)

const originalProjectId = (await evalExpr(`window.electronAPI.projects.getActive().then(project => project?.id ?? null)`)).result.value
let testProject = null

try {
const setup = await evalExpr(`(async () => {
  const projects = await window.electronAPI.projects.list()
  let project = projects.find(p => /BrightCode$/i.test(p.path))
  let projectCreated = false
  if (!project) {
    const added = await window.electronAPI.projects.add(${JSON.stringify(PROJECT_PATH)}, 'BrightCode bash smoke')
    if (!added.ok) return { error: added.error }
    project = added.project
    projectCreated = true
  }
  await window.electronAPI.projects.setActive(project.id)
  return { projectId: project.id, projectCreated }
})()`)
const setupState = setup.result.value
if (!setupState?.projectId) throw new Error(`Bash test project unavailable: ${JSON.stringify(setupState)}`)
testProject = setupState
console.log('Setup →', JSON.stringify(setupState))
await sleep(600)

function findDialogState() {
  return evalExpr(`(() => {
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
}

function clickButton(label) {
  // Find the button by its visible text and click it.
  return evalExpr(`(() => {
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog) return 'NO DIALOG'
    const btn = Array.from(dialog.querySelectorAll('button')).find(b => b.textContent?.trim() === ${JSON.stringify(label)})
    if (!btn) return 'NO BUTTON: ${label}'
    btn.click()
    return 'clicked'
  })()`)
}

// ── Test 1: Deny flow ──────────────────────────────────────────────────
console.log('\n=== Test 1: Deny ===')
// Fire the call but don't await yet — we need to interact with the modal.
const denyPromise = evalExpr(`window.electronAPI.tools.execute('bash', { command: 'echo denied-test' })`)
// Wait for the modal to appear
let dialogState
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
console.log('Modal state →', dialogState)
if (!dialogState.open) {
  console.error('FAIL: approval modal did not appear')
  throw new Error('Bash approval smoke failed')
}
if (!dialogState.command?.includes('echo denied-test')) {
  console.error('FAIL: modal command mismatch — got:', dialogState.command)
  throw new Error('Bash approval smoke failed')
}
const denyClick = await clickButton('Deny')
console.log('Click Deny →', denyClick.result.value)
const denyResult = (await denyPromise).result.value
console.log('Result →', JSON.stringify(denyResult))
if (denyResult.ok !== false || !String(denyResult.error).includes('User denied')) {
  console.error('FAIL: expected { ok: false, error: "User denied..." }')
  throw new Error('Bash approval smoke failed')
}
// Modal should be gone
await sleep(300)
const afterDeny = JSON.parse((await findDialogState()).result.value)
if (afterDeny.open) {
  console.error('FAIL: modal still open after Deny')
  throw new Error('Bash approval smoke failed')
}

// ── Test 2: Renderer reload keeps approval recoverable ────────────────
console.log('\n=== Test 2: Reload recovery ===')
void evalExpr(`window.electronAPI.tools.execute('bash', { command: 'echo reload-recovery' })`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
if (!dialogState.open) throw new Error('Reload recovery approval missing before reload')
await send('Page.reload', {})
for (let i = 0; i < 80; i++) {
  await sleep(150)
  const rootReady = (await evalExpr(`document.getElementById('root')?.children.length > 0`)).result?.value
  if (!rootReady) continue
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.command?.includes('reload-recovery')) break
}
if (!dialogState.open || !dialogState.command?.includes('reload-recovery')) {
  throw new Error(`Approval did not recover after renderer reload: ${JSON.stringify(dialogState)}`)
}
await clickButton('Deny')
await sleep(300)

// ── Test 3: Approve flow ───────────────────────────────────────────────
console.log('\n=== Test 3: Approve ===')
const approvePromise = evalExpr(`window.electronAPI.tools.execute('bash', { command: 'echo hello-brightcode && cd' })`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
console.log('Modal state →', dialogState)
if (!dialogState.open) {
  console.error('FAIL: approval modal did not appear (approve)')
  throw new Error('Bash approval smoke failed')
}
if (!dialogState.command?.includes('echo hello-brightcode')) {
  console.error('FAIL: modal command mismatch (approve) — got:', dialogState.command)
  throw new Error('Bash approval smoke failed')
}
const approveClick = await clickButton('Approve')
console.log('Click Approve →', approveClick.result.value)
const approveResult = (await approvePromise).result.value
console.log('Result →', JSON.stringify(approveResult, null, 2))
if (approveResult.ok !== true) {
  console.error('FAIL: expected ok=true — got', JSON.stringify(approveResult))
  throw new Error('Bash approval smoke failed')
}
if (!String(approveResult.result.stdout).includes('hello-brightcode')) {
  console.error('FAIL: expected stdout to contain "hello-brightcode" — got', approveResult.result.stdout)
  throw new Error('Bash approval smoke failed')
}
if (typeof approveResult.result.exitCode !== 'number' || approveResult.result.exitCode !== 0) {
  console.error('FAIL: expected exitCode 0 — got', approveResult.result.exitCode)
  throw new Error('Bash approval smoke failed')
}

// ── Test 3: Explicitly approved cwd escape ─────────────────────────────
console.log('\n=== Test 3: approved cwd escape ===')
const cwdPromise = evalExpr(`window.electronAPI.tools.execute('bash', { command: 'cd .. && cd' })`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
if (!dialogState.open) {
  console.error('FAIL: modal did not appear for cwd test')
  throw new Error('Bash approval smoke failed')
}
const cwdApprove = await clickButton('Approve')
console.log('Click Approve →', cwdApprove.result.value)
const cwdResult = (await cwdPromise).result.value
console.log('Result →', JSON.stringify(cwdResult, null, 2))
if (cwdResult.ok !== true) {
  console.error('FAIL: approved cd .. should succeed — got', JSON.stringify(cwdResult))
  throw new Error('Bash approval smoke failed')
}
// `cd` after `cd ..` prints the project PARENT — resolveInProject only
// protects the *initial* cwd, not shell-level cd. So this command WILL
// escape. We don't assert on the value — we just confirm it ran without
// crashing. (Future work: run commands through `node:child_process` with
// `cwd: workdir` enforced at every step; current behavior is the documented
// "user has already approved the exact command" model.)
console.log('Note: shell cd inside an approved command is not sandboxed by the tool. The user saw the command in the modal and approved it explicitly.')

// ── Test 4: Timeout ────────────────────────────────────────────────────
console.log('\n=== Test 4: Timeout ===')
const timeoutMarker = `BC_TIMEOUT_${Date.now()}`
const timeoutPromise = evalExpr(`window.electronAPI.tools.execute('bash', { command: 'node -e "setTimeout(() => {}, 30000)" ${timeoutMarker}', timeoutMs: 1500 })`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
if (!dialogState.open) {
  console.error('FAIL: modal did not appear for timeout test')
  throw new Error('Bash approval smoke failed')
}
const timeoutApprove = await clickButton('Approve')
console.log('Click Approve →', timeoutApprove.result.value)
const timeoutResult = (await timeoutPromise).result.value
console.log('Result →', JSON.stringify(timeoutResult, null, 2))
if (timeoutResult.ok !== false || !String(timeoutResult.error).includes('exceeded timeout')) {
  console.error('FAIL: expected timeout error — got', JSON.stringify(timeoutResult))
  throw new Error('Bash approval smoke failed')
}
await sleep(500)
const orphanCommand = `powershell -NoProfile -NonInteractive -Command "$marker = '${timeoutMarker}'; $count = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like ('*' + $marker + '*') }).Count; Write-Output $count"`
const orphanProbe = evalExpr(`window.electronAPI.tools.execute('bash', { command: ${JSON.stringify(orphanCommand)} })`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
if (!dialogState.open) throw new Error('Orphan probe approval missing')
await clickButton('Approve')
const orphanResult = (await orphanProbe).result.value
if (orphanResult.ok !== true || orphanResult.result.stdout.trim() !== '0') {
  throw new Error(`Timed-out process survived: ${JSON.stringify(orphanResult)}`)
}

// ── Test 5: Output cap preserves valid UTF-8 in both streams ───────────
console.log('\n=== Test 5: Output cap ===')
const outputCapPromise = evalExpr(`window.electronAPI.tools.execute('bash', { command: 'node -e "process.stdout.write(\\'€\\'.repeat(100000)); process.stderr.write(\\'€\\'.repeat(100000))"' })`)
for (let i = 0; i < 30; i++) {
  await sleep(150)
  dialogState = JSON.parse((await findDialogState()).result.value)
  if (dialogState.open) break
}
if (!dialogState.open) throw new Error('Output cap approval missing')
await clickButton('Approve')
const outputCapResult = (await outputCapPromise).result.value
const { stdout, stderr } = outputCapResult.result ?? {}
const stdoutPayload = stdout?.split('\n\n[stdout truncated at 200000 bytes]')[0]
const stderrPayload = stderr?.split('\n\n[stderr truncated at 200000 bytes]')[0]
if (
  outputCapResult.ok !== true
  || !stdout?.endsWith('[stdout truncated at 200000 bytes]')
  || !stderr?.endsWith('[stderr truncated at 200000 bytes]')
  || stdoutPayload?.length !== 66_666
  || stderrPayload?.length !== 66_666
  || Buffer.byteLength(stdoutPayload, 'utf8') !== 199_998
  || Buffer.byteLength(stderrPayload, 'utf8') !== 199_998
  || stdout.includes('\uFFFD')
  || stderr.includes('\uFFFD')
) {
  throw new Error(`Output cap corrupted UTF-8: ${JSON.stringify({ ok: outputCapResult.ok, stdoutPayloadChars: stdoutPayload?.length, stderrPayloadChars: stderrPayload?.length, stdoutPayloadBytes: stdoutPayload && Buffer.byteLength(stdoutPayload, 'utf8'), stderrPayloadBytes: stderrPayload && Buffer.byteLength(stderrPayload, 'utf8'), stdoutTail: stdout?.slice(-50), stderrTail: stderr?.slice(-50) })}`)
}

console.log('\n=== Console (last 20) ===')
for (const log of consoleLogs.slice(-20)) {
  const text = (log.args || []).map(a => a.value ?? a.description ?? '').join(' ')
  console.log(`[${log.type}] ${text.slice(0, 200)}`)
}
console.log('\n=== Exceptions ===')
for (const e of exceptions) {
  console.log(JSON.stringify(e).slice(0, 400))
}

console.log('\nAll bash tests passed.')
} finally {
  const cleanup = await evalExpr(`(async () => {
    const originalId = ${JSON.stringify(originalProjectId)}
    const projects = await window.electronAPI.projects.list()
    if (originalId && projects.some(p => p.id === originalId)) {
      await window.electronAPI.projects.setActive(originalId)
    }
    const testProject = ${JSON.stringify(testProject)}
    if (testProject?.projectCreated && projects.some(p => p.id === testProject.projectId)) {
      await window.electronAPI.projects.remove(testProject.projectId)
    }
    return 'cleaned'
  })()`)
  console.log('\nCleanup →', cleanup.result.value)
  ws.close()
}
