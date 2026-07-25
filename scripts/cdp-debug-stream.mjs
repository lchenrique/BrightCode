/**
 * Debug: call providerRegistry.stream directly to see if the agent loop
 * even runs. Doesn't involve the UI.
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
  if (msg.method === 'Runtime.exceptionThrown') consoleLogs.push({ type: 'exception', args: [{ value: JSON.stringify(msg.params.exceptionDetails) }] })
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 1500))

// Test: just call providerRegistry.stream directly and see what happens
const stream = await evalExpr(`(async () => {
  const chunks = []
  try {
    for await (const chunk of window.__brightcodeRegistry.stream('opencode-zen/big-pickle', {
      model: 'opencode-zen/big-pickle',
      messages: [{ role: 'user', content: 'Say "hi" in one word.' }],
      systemPrompt: 'You are a test. Be brief.',
      maxTokens: 64,
      temperature: 0,
    })) {
      chunks.push({ type: chunk.type, preview: chunk.text?.slice(0, 60) ?? JSON.stringify(chunk).slice(0, 80) })
    }
    return JSON.stringify({ ok: true, count: chunks.length, chunks: chunks.slice(0, 10) })
  } catch (err) {
    return JSON.stringify({ ok: false, error: err.message, stack: err.stack })
  }
})()`)
console.log('Stream result →')
console.log(stream.result.value)

console.log('\nConsole logs:')
for (const log of consoleLogs.slice(-20)) {
  const text = (log.args || []).map(a => a.value ?? a.description ?? '').join(' ')
  console.log(`[${log.type}] ${text.slice(0, 300)}`)
}

process.exit(0)
