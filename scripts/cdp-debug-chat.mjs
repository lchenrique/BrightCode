import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find((target) => target.type === 'page' && target.url.startsWith('http://localhost:5180'))
if (!page) throw new Error('renderer not found')

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
  if (payload.method === 'Runtime.exceptionThrown') exceptions.push(payload.params.exceptionDetails)
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
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}
await send('Runtime.enable')
const tmpRoot = await mkdtemp(resolve(tmpdir(), 'brightcode-debug-'))
const projectDir = resolve(tmpRoot, 'project')
await mkdir(projectDir)
const label = `Chat Smoke ${Date.now()}`
const agentName = `Agent Smoke ${Date.now()}`
try {
  const result = await evaluate(`(async () => {
    const project = await window.electronAPI.projects.add(${JSON.stringify(projectDir)}, ${JSON.stringify(label)});
    let agent = null;
    let agentError = null;
    try {
      agent = await window.electronAPI.agents.add({
        name: ${JSON.stringify(agentName)},
        avatarSeed: 'chat-smoke',
        description: 'Tauri chat smoke agent',
        systemPrompt: 'Reply concisely.',
        model: 'opencode-zen/big-pickle',
        tools: [],
        enabled: true,
      });
    } catch (error) { agentError = String(error); }
    const list = await window.electronAPI.agents.list();
    return { project: project.ok ? project.project : project, list, agentError };
  })()`)
  console.log(JSON.stringify({
    exceptions: exceptions.slice(),
    consoleErrors: consoleErrors.slice(),
    result,
  }, null, 2))
} finally {
  await rm(tmpRoot, { recursive: true, force: true })
  ws.close()
}
