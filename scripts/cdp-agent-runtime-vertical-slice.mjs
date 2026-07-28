import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((target) =>
  target.type === 'page' && target.url.startsWith('http://localhost:5180'),
)
if (!page) throw new Error('BrightCode renderer not found on CDP port 9222.')

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
    consoleErrors.push(payload.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
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

async function waitFor(expression, timeoutMs = 12_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(expression)
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

await send('Runtime.enable')
await send('Page.enable')

const flagUrl = `${new URL(page.url).origin}/?agentRuntimeV2=1`
await evaluate(`location.href = ${JSON.stringify(flagUrl)}`)
await new Promise((resolveWait) => setTimeout(resolveWait, 1_500))

const taskTitle = 'Runtime V2 CDP'
const taskId = await evaluate(`(async () => {
  const tasks = await window.electronAPI.tasks.list()
  for (const task of tasks.filter((item) => item.title === ${JSON.stringify(taskTitle)})) {
    await window.electronAPI.tasks.remove(task.id)
  }
  const created = await window.electronAPI.tasks.create({
    projectId: null,
    title: ${JSON.stringify(taskTitle)},
  })
  return created.id
})()`)

await waitFor(`(() => {
  const button = Array.from(document.querySelectorAll('button'))
    .find((item) => item.textContent?.includes(${JSON.stringify(taskTitle)}))
  if (!button) return false
  button.click()
  return true
})()`)
await waitFor(`Boolean(document.querySelector('[data-agent-runtime-v2="true"]'))`)

const prompt = `persistência cdp ${Date.now()}`
await evaluate(`(() => {
  const textarea = document.querySelector('textarea[aria-label="Mensagem para o Agent Runtime V2"]')
  if (!textarea) throw new Error('Runtime textarea not found.')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, ${JSON.stringify(prompt)})
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.form.requestSubmit()
})()`)

await waitFor(`document.querySelector('[data-runtime-status="running"]') !== null`)
await waitFor(`Number(document.querySelector('[data-agent-runtime-v2]')?.dataset.sequence ?? 0) >= 6`)

// Reload the renderer while the main process keeps streaming.
await evaluate('location.reload()')
await new Promise((resolveWait) => setTimeout(resolveWait, 1_300))

await waitFor(`(() => {
  const button = Array.from(document.querySelectorAll('button'))
    .find((item) => item.textContent?.includes(${JSON.stringify(taskTitle)}))
  if (!button) return false
  button.click()
  return true
})()`)
await waitFor(`Boolean(document.querySelector('[data-agent-runtime-v2="true"]'))`)
await waitFor(`document.querySelector('[data-runtime-status="completed"]') !== null`, 20_000)

const result = await evaluate(`(async () => {
  const root = document.querySelector('[data-agent-runtime-v2="true"]')
  const threadId = root?.dataset.threadId
  if (!threadId) throw new Error('Thread id missing after reload.')
  const history = await window.electronAPI.agentRuntime.readHistory({
    threadId,
    afterSequence: -1,
  })
  const sequences = history.map((event) => event.sequence)
  return {
    threadId,
    text: root.textContent,
    userItems: document.querySelectorAll('[data-runtime-item="user-message"]').length,
    agentItems: document.querySelectorAll('[data-runtime-item="agent-message"]').length,
    reasoningItems: document.querySelectorAll('[data-runtime-item="reasoning"]').length,
    sequenceCount: sequences.length,
    uniqueSequenceCount: new Set(sequences).size,
    sorted: sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]),
    terminalCount: history.filter((event) =>
      ['turn-complete', 'turn-failed', 'turn-interrupted'].includes(event.type),
    ).length,
  }
})()`)

if (!result.text.includes(prompt)) throw new Error('User message was not restored after reload.')
if (!result.text.includes('A resposta continuou no processo principal')) {
  throw new Error('Agent response did not complete after renderer reload.')
}
if (result.userItems !== 1 || result.agentItems !== 1 || result.reasoningItems !== 1) {
  throw new Error(`Unexpected transcript item counts: ${JSON.stringify(result)}`)
}
if (result.sequenceCount !== result.uniqueSequenceCount || !result.sorted) {
  throw new Error(`Duplicate or regressing events: ${JSON.stringify(result)}`)
}
if (result.terminalCount !== 1) {
  throw new Error(`Expected one terminal event: ${JSON.stringify(result)}`)
}
if (exceptions.length > 0) {
  throw new Error(`Renderer exceptions: ${JSON.stringify(exceptions)}`)
}
if (consoleErrors.length > 0) {
  throw new Error(`Renderer console errors: ${JSON.stringify(consoleErrors)}`)
}

await evaluate(`(() => {
  const textarea = document.querySelector('textarea[aria-label="Mensagem para o Agent Runtime V2"]')
  if (!textarea) throw new Error('Runtime textarea not found for interruption.')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(textarea, 'interromper este turno')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
  textarea.form.requestSubmit()
})()`)
await waitFor(`document.querySelector('[data-runtime-status="running"]') !== null`)
await waitFor(`(() => {
  const button = document.querySelector('button[aria-label="Interromper turno"]')
  if (!button) return false
  button.click()
  return true
})()`)
await waitFor(`document.querySelector('[data-runtime-status="interrupted"]') !== null`)

const interruption = await evaluate(`(async () => {
  const threadId = document.querySelector('[data-agent-runtime-v2]')?.dataset.threadId
  const history = await window.electronAPI.agentRuntime.readHistory({ threadId, afterSequence: -1 })
  return {
    interrupted: history.filter((event) => event.type === 'turn-interrupted').length,
    terminals: history.filter((event) =>
      ['turn-complete', 'turn-failed', 'turn-interrupted'].includes(event.type),
    ).length,
  }
})()`)
if (interruption.interrupted !== 1 || interruption.terminals !== 2) {
  throw new Error(`Interruption was not projected once: ${JSON.stringify(interruption)}`)
}

const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
const scriptDir = dirname(fileURLToPath(import.meta.url))
const screenshotPath = resolve(scriptDir, 'screenshots', 'cdp-agent-runtime-vertical-slice.png')
await mkdir(dirname(screenshotPath), { recursive: true })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

await evaluate(`window.electronAPI.tasks.remove(${JSON.stringify(taskId)})`)
console.log(JSON.stringify({ ...result, interruption, screenshotPath }, null, 2))
ws.close()
