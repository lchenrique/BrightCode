import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://localhost:5180'),
)
if (!page) {
  console.error('Tauri renderer not found on CDP port 9222')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const exceptions = []
const consoleErrors = []
const consoleAll = []

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
    ['error', 'assert', 'warning'].includes(payload.params.type)
  ) {
    const text = payload.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    consoleErrors.push(`[${payload.params.type}] ${text}`)
  }
  if (payload.method === 'Runtime.consoleAPICalled') {
    const text = payload.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    consoleAll.push(`[${payload.params.type}] ${text}`)
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

const snapshot = await evaluate(`(async () => {
  const root = document.getElementById('root');
  const html = document.documentElement.outerHTML.length;
  const body = document.body?.textContent?.trim().length ?? 0;
  const electronAPIPresent = Boolean(window.electronAPI);
  const electronAPIKeys = window.electronAPI ? Object.keys(window.electronAPI).length : 0;
  const reactRoot = root ? root.children.length : 0;
  return {
    documentReadyState: document.readyState,
    documentTitle: document.title,
    bodyTextLength: body,
    outerHTMLLength: html,
    electronAPIPresent,
    electronAPIKeys,
    reactRootChildren: reactRoot,
    rootInnerHTML: root ? root.innerHTML.slice(0, 500) : null,
    registryExposed: Boolean(window.__brightcodeRegistry),
    renderer: window.__brightcodeRegistry ? Object.keys(window.__brightcodeRegistry).slice(0, 10) : null,
  };
})()`)

const samples = []
for (let i = 0; i < 18; i++) {
  const sample = await evaluate(`(async () => {
    return {
      ts: Date.now(),
      bodyTextLength: document.body?.textContent?.trim().length ?? 0,
      rootChildren: document.getElementById('root')?.children.length ?? 0,
      firstChildTag: document.getElementById('root')?.children?.[0]?.tagName ?? null,
      firstChildClass: document.getElementById('root')?.children?.[0]?.className ?? null,
      visibleText: document.body?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 200) ?? '',
    };
  })()`)
  samples.push(sample)
  await new Promise((r) => setTimeout(r, 1000))
}

const result = {
  observedAt: new Date().toISOString(),
  snapshot,
  samples,
  exceptions: exceptions.slice(-10),
  consoleErrors: consoleErrors.slice(-20),
  consoleTail: consoleAll.slice(-20),
}

const scriptDir = dirname(fileURLToPath(import.meta.url))
const out = resolve(scriptDir, 'screenshots', 'cdp-tauri-blank-monitor.json')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(result, null, 2))

console.log(JSON.stringify({
  ...result,
  out,
}, null, 2))
ws.close()
