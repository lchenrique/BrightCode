import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  if (payload.method === 'Runtime.exceptionThrown') exceptions.push(payload.params.exceptionDetails)
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

async function waitFor(expression, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await evaluate(expression)
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`Timed out waiting for: ${expression}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

await send('Runtime.enable')
await send('Page.enable')
await waitFor(`Boolean(window.electronAPI?.projects && window.electronAPI?.agents && document.querySelector('#root'))`)
const baselineExceptions = exceptions.length
const baselineConsoleErrors = consoleErrors.length

const tmpRoot = await mkdtemp(resolve(tmpdir(), 'brightcode-chat-smoke-'))
const projectDir = resolve(tmpRoot, 'project')
await mkdir(projectDir)
const label = `Chat Smoke ${Date.now()}`
const agentName = `Agent Smoke ${Date.now()}`
const projectPrompt = 'Reply only with OK for the project chat smoke.'
const agentPrompt = 'Reply only with OK for the agent chat smoke.'
let projectId
let agentId

try {
  const setup = await evaluate(`(async () => {
    const project = await window.electronAPI.projects.add(
      ${JSON.stringify(projectDir)},
      ${JSON.stringify(label)},
    );
    if (!project.ok) throw new Error(project.error);
    await window.electronAPI.projects.setActive(project.project.id);
    const agent = await window.electronAPI.agents.add({
      name: ${JSON.stringify(agentName)},
      avatarSeed: 'chat-smoke',
      description: 'Tauri chat smoke agent',
      systemPrompt: 'Reply concisely.',
      model: 'opencode-zen/big-pickle',
      tools: [],
      enabled: true,
    });
    return { project: project.project, agent };
  })()`)
  projectId = setup.project.id
  agentId = setup.agent.id

  await waitFor(`Array.from(document.querySelectorAll('button[title]')).some(
    (button) => button.title === ${JSON.stringify(setup.project.path)}
  )`)
  await evaluate(`(() => {
    const projectButton = Array.from(document.querySelectorAll('button[title]')).find(
      (button) => button.title === ${JSON.stringify(setup.project.path)}
    );
    const newTask = projectButton?.parentElement?.querySelector('button[title="New task for this project"]');
    if (!newTask) throw new Error('New project conversation button not found');
    newTask.click();
  })()`)
  await waitFor(`Boolean(document.querySelector('textarea[placeholder*="Enter message"]'))`)
  const projectInputClass = await evaluate(`document.querySelector('textarea[placeholder*="Enter message"]')?.className`)
  await evaluate(`(() => {
    const input = document.querySelector('textarea[placeholder*="Enter message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(projectPrompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitFor(`document.querySelector('button[aria-label="Send"]')?.disabled === false`)
  await evaluate(`document.querySelector('button[aria-label="Send"]').click()`)
  await waitFor(`document.body.textContent.includes(${JSON.stringify(projectPrompt)})`, 15_000)
  assert(!(await evaluate(`document.body.textContent.includes('Agent Runtime V2')`)), 'project opened obsolete runtime transcript')

  await waitFor(`Array.from(document.querySelectorAll('button')).some(
    (button) => button.textContent.includes(${JSON.stringify(agentName)})
  )`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent.includes(${JSON.stringify(agentName)})
  ).click()`)
  await waitFor(`document.body.textContent.includes('Tauri chat smoke agent')`)
  await waitFor(`Boolean(document.querySelector('textarea[placeholder*="Enter message"]'))`)
  const agentInputClass = await evaluate(`document.querySelector('textarea[placeholder*="Enter message"]')?.className`)
  await evaluate(`(() => {
    const input = document.querySelector('textarea[placeholder*="Enter message"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(agentPrompt)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitFor(`document.querySelector('button[aria-label="Send"]')?.disabled === false`)
  await evaluate(`document.querySelector('button[aria-label="Send"]').click()`)
  await waitFor(`document.body.textContent.includes(${JSON.stringify(agentPrompt)})`, 15_000)

  assert(projectInputClass === agentInputClass, 'project and agent chats use different input surfaces')
  const newExceptions = exceptions.slice(baselineExceptions)
  const newConsoleErrors = consoleErrors.slice(baselineConsoleErrors)
  const ipcErrors = [
    ...newExceptions.map((error) => JSON.stringify(error)),
    ...newConsoleErrors,
  ].filter((message) => /is not a function|unknown command|ipc|sidecar returned/i.test(message))
  assert(ipcErrors.length === 0, `function/IPC errors: ${JSON.stringify(ipcErrors)}`)

  const screenshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const screenshotPath = resolve(scriptDir, 'screenshots', 'cdp-tauri-chat-smoke.png')
  await mkdir(dirname(screenshotPath), { recursive: true })
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  console.log(JSON.stringify({
    projectId,
    agentId,
    projectConversationCreated: true,
    agentChatOpened: true,
    sharedChatSurface: projectInputClass === agentInputClass,
    ipcErrors,
    screenshotPath,
  }, null, 2))
} finally {
  if (projectId || agentId) {
    await evaluate(`(async () => {
      const projectId = ${JSON.stringify(projectId)};
      const agentId = ${JSON.stringify(agentId)};
      if (projectId) {
        const tasks = await window.electronAPI.tasks.list(projectId);
        await Promise.all(tasks.map((task) => window.electronAPI.tasks.remove(task.id)));
        await window.electronAPI.projects.remove(projectId);
      }
      if (agentId) await window.electronAPI.agents.remove(agentId);
    })()`).catch(() => undefined)
  }
  await rm(tmpRoot, { recursive: true, force: true })
  ws.close()
}
