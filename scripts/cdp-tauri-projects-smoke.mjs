/**
 * Phase 3 / F1+F2 — Projects + Bright Memory CDP smoke.
 *
 * Drives the live Tauri WebView2 over CDP. Calls:
 *   - fs.home
 *   - fs.listDirs (against a known directory)
 *   - projects.list / projects.getActive
 *   - projects.add (against a temp dir) + projects.onChanged fires
 *   - bright_memory.status
 *
 * Pass criteria: every call returns the expected shape; the
 * projects:changed listener fires at least once; no new renderer
 * errors beyond the pre-existing use-cli-detection probe noise.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://localhost:5180'),
)
if (!page) {
  throw new Error(
    'BrightCode Tauri renderer not found on CDP port 9222. ' +
      'Is `npm run tauri:dev` running?',
  )
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const exceptions = []
const consoleErrors = []

await new Promise((resolveOpen, rejectOpen) => {
  ws.addEventListener('open', resolveOpen, { once: true })
  ws.addEventListener('error', rejectOpen, { once: true })
})

ws.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) {
    const { resolve: resolveCommand, reject } = pending.get(payload.id)
    pending.delete(payload.id)
    if (payload.error) reject(new Error(payload.error.message))
    else resolveCommand(payload.result)
  }
  if (payload.method === 'Runtime.exceptionThrown') {
    exceptions.push(payload.params.exceptionDetails)
  }
  if (
    payload.method === 'Runtime.consoleAPICalled' &&
    ['error', 'assert'].includes(payload.params.type)
  ) {
    consoleErrors.push(
      payload.params.args
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' '),
    )
  }
})

function send(method, params = {}) {
  const commandId = ++id
  ws.send(JSON.stringify({ id: commandId, method, params }))
  return new Promise((resolveCommand, reject) => {
    pending.set(commandId, { resolve: resolveCommand, reject })
  })
}

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? 'Renderer evaluation failed.')
  }
  return response.result.value
}

async function waitFor(expression, timeoutMs = 20_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression)
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

await send('Runtime.enable')
await send('Page.enable')

await waitFor(
  `Boolean(window.electronAPI && window.electronAPI.projects && window.electronAPI.brightMemory)`,
  20_000,
)

// Snapshot pre-existing noise so we only fail on errors the smoke itself causes.
const baselineExceptions = exceptions.length
const baselineConsoleErrors = consoleErrors.length

// Prepare a real directory on disk so projects.add can succeed.
const tmpRoot = mkdtempSync(resolve(tmpdir(), 'cdp-projects-').replace(/[\\/]+$/, ''))
const projectDir = resolve(tmpRoot, 'demo-project')
await mkdir(projectDir, { recursive: true })

const result = await evaluate(`(async () => {
  const out = {}

  // fs.home
  out.home = await window.electronAPI.fs.home();

  // fs.listDirs against tmpRoot — must include demo-project
  out.listDirs = await window.electronAPI.fs.listDirs(${JSON.stringify(tmpRoot)});

  // projects.list — should be an array
  out.projectsList = await window.electronAPI.projects.list();

  // Subscribe to projects:changed via the bridge's onChanged
  let changedCount = 0;
  window.__changedProbe = () => { changedCount += 1; };
  out.unsub = await window.electronAPI.projects.onChanged(window.__changedProbe);

  // Add our temp project
  out.addResult = await window.electronAPI.projects.add(
    ${JSON.stringify(projectDir)},
    'cdp-smoke-project',
  );

  // getActive should now point at the just-added project (first project auto-activates)
  out.activeAfterAdd = await window.electronAPI.projects.getActive();

  // Remove it (clean up)
  if (out.addResult && out.addResult.ok) {
    out.removeResult = await window.electronAPI.projects.remove(out.addResult.project.id);
  }

  // bright_memory.status — payload shape sanity
  out.brightMemory = await window.electronAPI.brightMemory.status();

  // List again to confirm cleanup
  out.projectsListAfter = await window.electronAPI.projects.list();

  out.changedCount = changedCount;
  return out;
})()`)

// Cleanup tmp dir
await rm(tmpRoot, { recursive: true, force: true })

// ── Assertions ──────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
}

assert(typeof result.home === 'string' && result.home.length > 0, 'fs.home returned non-string')
assert(
  result.listDirs.ok && result.listDirs.entries.some((e) => e.name === 'demo-project'),
  `fs.listDirs did not return demo-project under ${tmpRoot}`,
)
assert(Array.isArray(result.projectsList), 'projects.list not array')
assert(
  result.addResult.ok === true && typeof result.addResult.project?.id === 'string',
  `projects.add failed: ${JSON.stringify(result.addResult)}`,
)
assert(
  result.activeAfterAdd && result.activeAfterAdd.id === result.addResult.project.id,
  'projects.getActive did not auto-pick the new project',
)
assert(result.removeResult && result.removeResult.ok === true, 'projects.remove failed')
assert(
  Array.isArray(result.brightMemory.rulePaths) &&
    typeof result.brightMemory.cliInstalled === 'boolean',
  `brightMemory.status shape wrong: ${JSON.stringify(result.brightMemory)}`,
)
assert(
  result.changedCount >= 1,
  `projects:changed listener did not fire (count=${result.changedCount})`,
)
assert(
  !result.projectsListAfter.some(
    (p) => p.id === result.addResult.project.id,
  ),
  'projects.list still contains the removed project',
)

const newExceptions = exceptions.slice(baselineExceptions)
const newConsoleErrors = consoleErrors.slice(baselineConsoleErrors)
if (newExceptions.length > 0 || newConsoleErrors.length > 0) {
  throw new Error(
    `Smoke surfaced renderer errors: ${JSON.stringify({ newExceptions, newConsoleErrors })}`,
  )
}

// Capture screenshot
const screenshot = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
})
const scriptDir = dirname(fileURLToPath(import.meta.url))
const screenshotPath = resolve(
  scriptDir,
  'screenshots',
  'cdp-tauri-projects-smoke.png',
)
await mkdir(dirname(screenshotPath), { recursive: true })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

console.log(
  JSON.stringify(
    {
      home: result.home,
      projectAdded: result.addResult.project?.path,
      projectActive: result.activeAfterAdd?.id === result.addResult.project?.id,
      projectRemoved: result.removeResult?.ok === true,
      changedCount: result.changedCount,
      brightMemoryReady: result.brightMemory.ready,
      brightMemoryRulePaths: result.brightMemory.rulePaths.length,
      screenshotPath,
    },
    null,
    2,
  ),
)
ws.close()
