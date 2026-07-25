/**
 * Connects to the Electron DevTools Protocol and runs a JS expression
 * in the renderer to inspect the registry state. Used to debug
 * `useAvailableModelsGrouped()` without a GUI.
 *
 * Usage:
 *   1. Start Vite: npm run dev
 *   2. Start Electron with VITE_DEV_SERVER_URL=http://localhost:5180 \
 *                --remote-debugging-port=9222
 *   3. node scripts/cdp-inspect.mjs
 */

const HOST = 'http://localhost:9222'

async function listTargets() {
  const r = await fetch(`${HOST}/json`)
  return r.json()
}

async function connect(wsUrl) {
  let WS
  try {
    WS = globalThis.WebSocket
    if (!WS) throw new Error('no native WS')
  } catch {
    const { default: WS } = await import('ws')
    return connectWith(WS, wsUrl)
  }
  return connectWith(WS, wsUrl)
}

function connectWith(WS, wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl)
    let id = 0
    const pending = new Map()
    const consoleLogs = []
    const exceptions = []
    ws.addEventListener('open', () => {
      const send = (method, params) => {
        const mid = ++id
        ws.send(JSON.stringify({ id: mid, method, params }))
        return new Promise((res) => pending.set(mid, res))
      }
      resolve({ ws, send, consoleLogs, exceptions })
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result || msg.error)
        pending.delete(msg.id)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLogs.push(msg.params)
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push(msg.params.exceptionDetails)
      }
      if (msg.method === 'Log.entryAdded') {
        consoleLogs.push({ source: msg.params.entry.source, text: msg.params.entry.text })
      }
    })
  })
}

const targets = await listTargets()
const page = targets.find(
  (t) => t.type === 'page' && t.url.startsWith('http://localhost'),
)
if (!page) {
  console.error('No renderer page found. Available:')
  for (const t of targets) console.error('  -', t.type, t.url)
  process.exit(1)
}
console.log('Connecting to:', page.url)

const { send, consoleLogs, exceptions } = await connect(page.webSocketDebuggerUrl)

await send('Runtime.enable', {})
await send('Log.enable', {})

// Give the app a moment to finish booting
await new Promise((r) => setTimeout(r, 1500))

const diag = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasRegistry: typeof window.__brightcodeRegistry,
    bodyChildren: document.body?.children?.length,
    rootChildren: document.getElementById('root')?.children?.length,
    title: document.title,
    bodyHTML: document.body?.innerHTML?.slice(0, 200),
    hasElectron: typeof window.electronAPI,
    rootHTML: document.getElementById('root')?.innerHTML?.slice(0, 200),
  })`,
  returnByValue: true,
})

console.log('\n=== Diagnostic ===')
console.log(diag.result.value)

if (exceptions.length) {
  console.log('\n=== Exceptions ===')
  for (const e of exceptions) console.log(e)
}

if (consoleLogs.length) {
  console.log('\n=== Console logs ===')
  for (const l of consoleLogs) {
    const text = (l.args || [])
      .map((a) => a.value ?? a.description ?? '')
      .join(' ')
    console.log(`[${l.type ?? l.source}] ${text}`)
  }
}

const expr = `
JSON.stringify({
  listAllModels: window.__brightcodeRegistry?.listAllModels?.()?.map(m => ({
    id: m.id, provider: m.provider, free: !!m.free, requiresAuth: m.requiresAuth,
  })) || [],
  grouped: window.__brightcodeRegistry?.listAvailableModelsGrouped?.()?.map(g => ({
    provider: g.provider.name,
    hasCredential: g.hasCredential,
    models: g.models.map(m => m.id + (m.free ? ' (free)' : '')),
  })) || [],
}, null, 2)
`

const result = await send('Runtime.evaluate', {
  expression: expr,
  returnByValue: true,
  awaitPromise: true,
})

console.log('\n=== Registry state ===')
if (result.exceptionDetails) {
  console.log('Error:', result.exceptionDetails)
} else {
  console.log(result.result.value)
}

// Look for the model selector dropdown UI
const ui = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(t => t).slice(0, 30),
    options: Array.from(document.querySelectorAll('option')).map(o => o.textContent?.trim()),
    ariaLabels: Array.from(document.querySelectorAll('[aria-label]')).map(el => el.getAttribute('aria-label') + ': ' + el.textContent?.trim().slice(0, 40)),
  })`,
  returnByValue: true,
})

// Click the model selector to open the dropdown
const clickResult = await send('Runtime.evaluate', {
  expression: `(() => {
    const trigger = document.querySelector('button[aria-label*="Select model"]');
    if (trigger) trigger.click();
    return trigger ? 'clicked' : 'not found';
  })()`,
  returnByValue: true,
})
console.log('\nClick result:', clickResult.result.value)

// Wait for popover to render
await new Promise((r) => setTimeout(r, 500))

const popover = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    popoverText: document.querySelector('[data-slot="popover-content"]')?.textContent?.trim().slice(0, 800),
    groupLabels: Array.from(document.querySelectorAll('[data-slot="popover-content"] .uppercase')).map(el => el.textContent?.trim()),
    modelItems: Array.from(document.querySelectorAll('[data-slot="popover-content"] button')).map(b => b.textContent?.trim()).filter(t => t),
  })`,
  returnByValue: true,
})

console.log('\n=== Popover contents ===')
console.log(popover.result.value)

process.exit(0)
