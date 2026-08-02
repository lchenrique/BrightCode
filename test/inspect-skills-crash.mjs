import { setTimeout as wait } from 'node:timers/promises'
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
console.log('targets:', targets.map((t) => ({ type: t.type, title: t.title, url: t.url })))
const t = targets.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
let id = 0
const pending = new Map()
const events = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  } else if (msg.method) {
    events.push(msg)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const cmdId = ++id
    pending.set(cmdId, { resolve, reject })
    ws.send(JSON.stringify({ id: cmdId, method, params }))
  })
await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
await wait(800)
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const body = document.body
    const style = getComputedStyle(body)
    return {
      url: location.href,
      bodyChildren: body.children.length,
      bodyText: body.innerText.slice(0, 300),
      bodyBg: style.backgroundColor,
      bodyColor: style.color,
      rootChildren: document.getElementById('root')?.children.length,
      rootHtml: document.getElementById('root')?.innerHTML.slice(0, 400),
    }
  })()`,
  returnByValue: true,
})
console.log('STATE:', JSON.stringify(r.result.value, null, 2))
const logs = events.filter((e) => e.method === 'Log.entryAdded' || e.method === 'Runtime.exceptionThrown').slice(-10)
for (const e of logs) {
  if (e.method === 'Log.entryAdded') console.log('LOG:', e.params.entry.level, e.params.entry.text.slice(0, 300))
  else console.log('EXC:', e.params.exceptionDetails?.text, e.params.exceptionDetails?.exception?.description?.slice(0, 300))
}
ws.close()
process.exit(0)
