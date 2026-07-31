import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://localhost:5180'),
)
if (!page) throw new Error('BrightCode Tauri renderer not found on CDP port 9222.')

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
    const command = pending.get(payload.id)
    pending.delete(payload.id)
    if (payload.error) command.reject(new Error(payload.error.message))
    else command.resolve(payload.result)
  }
  if (payload.method === 'Runtime.exceptionThrown') {
    exceptions.push(payload.params.exceptionDetails)
  }
  if (
    payload.method === 'Runtime.consoleAPICalled' &&
    ['error', 'assert'].includes(payload.params.type)
  ) {
    consoleErrors.push(
      payload.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
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
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  }
  return response.result.value
}

await send('Runtime.enable')
await send('Page.enable')
const ready = await evaluate(`Boolean(
  window.electronAPI?.agentRuntime?.createThread &&
  window.electronAPI?.agentRuntime?.readThread &&
  window.electronAPI?.agentRuntime?.readHistory &&
  window.electronAPI?.agentRuntime?.startTurn &&
  window.electronAPI?.agentRuntime?.interruptTurn &&
  window.electronAPI?.agentRuntime?.subscribe
)`)
if (!ready) throw new Error('Agent Runtime bridge surface is incomplete.')

const baselineExceptions = exceptions.length
const baselineConsoleErrors = consoleErrors.length
const threadId = `cdp-runtime-${Date.now()}`
const result = await evaluate(`(async () => {
  const api = window.electronAPI.agentRuntime;
  const threadId = ${JSON.stringify(threadId)};
  const created = await api.createThread({ threadId });
  const before = await api.readThread({ threadId });
  const initialHistory = await api.readHistory({ threadId, afterSequence: -1 });
  const waiters = new Map();
  const waitFor = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ' + type)), 5000);
    waiters.set(type, (envelope) => { clearTimeout(timer); resolve(envelope); });
  });
  const unsubscribe = await api.subscribe({
    threadId,
    subscriptionId: 'cdp-sub-' + Date.now(),
    afterSequence: -1,
  }, (envelope) => {
    const resolve = waiters.get(envelope.event.type);
    if (resolve) { waiters.delete(envelope.event.type); resolve(envelope); }
  });
  try {
    const startedEvent = waitFor('turn-start');
    const started = await api.startTurn({ threadId, text: 'hello from CDP' });
    const startedEnvelope = await startedEvent;
    const history = await api.readHistory({ threadId, afterSequence: -1 });
    const interruptedEvent = waitFor('turn-interrupted');
    await api.interruptTurn({ threadId, turnId: started.turnId });
    const interruptedEnvelope = await interruptedEvent;
    const after = await api.readThread({ threadId });
    return {
      created,
      before,
      initialHistory,
      started,
      startedType: startedEnvelope.event.type,
      interruptedType: interruptedEnvelope.event.type,
      historyTypes: history.map((event) => event.type),
      after,
    };
  } finally {
    await unsubscribe();
  }
})()`)

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

assert(result.created.threadId === threadId, 'thread/create returned wrong id')
assert(result.before.threadId === threadId && result.before.sequence === 0, 'thread/read shape wrong')
assert(Array.isArray(result.initialHistory) && result.initialHistory.length === 0, 'new history not empty')
assert(typeof result.started.turnId === 'string', 'turn/start returned no turn id')
assert(result.startedType === 'turn-start', 'SSE did not relay turn-start')
assert(result.interruptedType === 'turn-interrupted', 'SSE did not relay interrupt')
assert(result.historyTypes.includes('turn-start'), 'history/read missed turn-start')
assert(result.after.idle === true && result.after.activeTurnId === undefined, 'thread stayed active')

const newExceptions = exceptions.slice(baselineExceptions)
const newConsoleErrors = consoleErrors.slice(baselineConsoleErrors)
assert(newExceptions.length === 0, `renderer exceptions: ${JSON.stringify(newExceptions)}`)
assert(newConsoleErrors.length === 0, `renderer console errors: ${JSON.stringify(newConsoleErrors)}`)

const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
const scriptDir = dirname(fileURLToPath(import.meta.url))
const screenshotPath = resolve(scriptDir, 'screenshots', 'cdp-tauri-agent-runtime-smoke.png')
await mkdir(dirname(screenshotPath), { recursive: true })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

console.log(JSON.stringify({
  threadId,
  historyTypes: result.historyTypes,
  startedType: result.startedType,
  interruptedType: result.interruptedType,
  screenshotPath,
}, null, 2))
ws.close()
