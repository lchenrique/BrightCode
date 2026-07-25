/**
 * Test the stream with tools passed.
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) { console.error('No page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
const consoleLogs = []
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
  if (msg.method === 'Runtime.consoleAPICalled') consoleLogs.push(msg.params)
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 1500))

// First, make sure there's an active project
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  if (list.length === 0) {
    const dir = await window.electronAPI.fs.defaultProjectsDir()
    const target = dir + '/bc-debug-tools'
    await window.electronAPI.fs.createDir(target)
    await window.electronAPI.tools.execute('write_file', { path: 'README.md', content: '# Debug\\n\\nThe marker is 4242.\\n' })
    await window.electronAPI.projects.add(target, 'bc-debug-tools')
  }
  const a = await window.electronAPI.projects.getActive()
  return JSON.stringify({ active: a })
})()`)
console.log('Setup →', setup.result.value)
await new Promise(r => setTimeout(r, 500))

// Test 1: stream with tools
const stream = await evalExpr(`(async () => {
  const tools = await import('/src/lib/agents/tools.ts')
  const { buildSystemPrompt } = await import('/src/lib/agents/system-prompt.ts')
  const chunks = []
  let stopReason = ''
  let modelName = ''
  let toolUseStart = null
  try {
    for await (const chunk of window.__brightcodeRegistry.stream('opencode-zen/big-pickle', {
      model: 'opencode-zen/big-pickle',
      messages: [
        { role: 'user', content: 'Use your read_file tool to open README.md and tell me the marker inside. One short sentence.' },
      ],
      systemPrompt: buildSystemPrompt({ project: await window.electronAPI.projects.getActive() }),
      tools: tools.AGENT_TOOLS,
      maxTokens: 512,
      temperature: 0,
    })) {
      chunks.push({ type: chunk.type, t: chunk.text?.slice(0, 80), name: chunk.name, stopReason: chunk.stopReason, model: chunk.model })
      if (chunk.type === 'tool_use_start') toolUseStart = chunk
      if (chunk.type === 'message_end') { stopReason = chunk.stopReason; modelName = chunk.model }
    }
    return JSON.stringify({ ok: true, count: chunks.length, stopReason, modelName, toolUseStart, sample: chunks.slice(0, 15) })
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message, stack: err.stack })
  }
})()`)
console.log('\nStream result →')
console.log(stream.result.value)

console.log('\nConsole logs:')
for (const log of consoleLogs.slice(-15)) {
  const text = (log.args || []).map(a => a.value ?? a.description ?? '').join(' ')
  console.log(`[${log.type}] ${text.slice(0, 200)}`)
}

process.exit(0)
