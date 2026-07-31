const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find((target) => target.type === 'page' && target.url.startsWith('http://localhost:5180'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((resolveOpen, rejectOpen) => {
  ws.addEventListener('open', resolveOpen, { once: true })
  ws.addEventListener('error', rejectOpen, { once: true })
})
function send(method, params = {}) {
  const commandId = ++id
  ws.send(JSON.stringify({ id: commandId, method, params }))
  return new Promise((resolveCommand, reject) => {
    pending.set(commandId, { resolve: resolveCommand, reject })
  })
}
ws.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) {
    const command = pending.get(payload.id)
    pending.delete(payload.id)
    if (payload.error) command.reject(new Error(payload.error.message))
    else command.resolve(payload.result)
  }
})
await send('Runtime.enable')
const response = await send('Runtime.evaluate', {
  expression: `(async () => {
    const list = await window.electronAPI.agents.list();
    return JSON.stringify({
      list: list.map((a) => a.name),
      sidebarButtons: Array.from(document.querySelectorAll('button'))
        .map((b) => b.textContent.trim())
        .filter((text) => text && text.includes('Agent'))
        .slice(0, 12),
    });
  })()`,
  returnByValue: true,
  awaitPromise: true,
})
console.log('raw=', response)
ws.close()
