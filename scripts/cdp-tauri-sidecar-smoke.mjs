/**
 * Phase 2 / Task 2.7 — full Tauri→Rust→sidecar CDP smoke.
 *
 * Runs while `npm run tauri:dev` is up on the host. Connects to
 * the WebView2 CDP endpoint on localhost:9222, evaluates
 * `window.electronAPI.agentRuntime.threadCreate({threadId:'cdp-smoke'})`
 * in the renderer, asserts the response carries the real
 * `ThreadState` shape, and captures a screenshot for the PR.
 *
 * ponytail: reuses the CDP helpers from
 * cdp-agent-runtime-vertical-slice.mjs verbatim — the connect
 * plumbing doesn't need to differ.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find(
  (target) =>
    target.type === 'page' &&
    target.url.startsWith('http://localhost:5180'),
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
    throw new Error(
      response.exceptionDetails.text ?? 'Renderer evaluation failed.',
    )
  }
  return response.result.value
}

async function waitFor(expression, timeoutMs = 15_000) {
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

// Wait for the renderer to boot and the Tauri bridge to install.
await waitFor(
  `Boolean(window.electronAPI && window.electronAPI.agentRuntime && window.electronAPI.agentRuntime.threadCreate)`,
  20_000,
)

// Give the sidecar a beat to finish booting after the renderer is
// up — first post() hits a cold child.
await new Promise((r) => setTimeout(r, 500))

// Snapshot the renderer's pre-existing error log so we only fail
// on errors that the smoke call itself causes. The renderer has
// unrelated dev-only noise (e.g. use-cli-detection running a Tauri
// plugin probe that's undefined outside Electron) that we don't
// want to gate the sidecar round-trip on.
const baselineExceptions = exceptions.length
const baselineConsoleErrors = consoleErrors.length

const smokeThreadId = `cdp-smoke-${Date.now()}`
const result = await evaluate(`(async () => {
  const fn = window.electronAPI.agentRuntime.threadCreate
  const out = await fn({ threadId: ${JSON.stringify(smokeThreadId)} })
  return {
    threadId: out?.threadId,
    thread: out?.thread,
  }
})()`)

if (result.threadId !== smokeThreadId) {
  throw new Error(
    `threadCreate returned threadId=${result.threadId}, expected ${smokeThreadId}`,
  )
}
if (!result.thread || typeof result.thread.threadId !== 'string') {
  throw new Error(`threadCreate returned no thread state: ${JSON.stringify(result)}`)
}
if (
  result.thread.generation !== 0 ||
  result.thread.sequence !== 0 ||
  result.thread.idle !== true
) {
  throw new Error(
    `ThreadState shape mismatch: ${JSON.stringify(result.thread)}`,
  )
}
const newExceptions = exceptions.slice(baselineExceptions)
const newConsoleErrors = consoleErrors.slice(baselineConsoleErrors)
if (newExceptions.length > 0 || newConsoleErrors.length > 0) {
  throw new Error(
    `threadCreate surfaced renderer errors: ${JSON.stringify({ newExceptions, newConsoleErrors })}`,
  )
}

const screenshot = await send('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
})
const scriptDir = dirname(fileURLToPath(import.meta.url))
const screenshotPath = resolve(
  scriptDir,
  'screenshots',
  'cdp-tauri-sidecar-smoke.png',
)
await mkdir(dirname(screenshotPath), { recursive: true })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

console.log(
  JSON.stringify(
    {
      threadId: result.threadId,
      threadShape: Object.keys(result.thread).sort(),
      screenshotPath,
    },
    null,
    2,
  ),
)
ws.close()