const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = targets.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const cmdId = ++id
    pending.set(cmdId, { resolve, reject })
    ws.send(JSON.stringify({ id: cmdId, method, params }))
  })
await send('Runtime.enable')
const expr = `window.electronAPI && window.electronAPI.skills
  ? window.electronAPI.skills.list(undefined).then(l => l.map(s => ({ id: s.id, name: s.name, source: s.source, sourceLabel: s.sourceLabel })))
  : 'NO API'`
const r = await send('Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 1))
ws.close()
process.exit(0)
