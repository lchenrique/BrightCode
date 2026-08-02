import { setTimeout as wait } from 'node:timers/promises'
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
console.log('targets:', targets.map((t) => ({ type: t.type, title: t.title, url: t.url })))
const t = targets.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
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
await wait(1000)
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const imgs = [...document.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), w: i.width }))
    const asides = document.querySelectorAll('aside').length
    const body = document.body.innerText.slice(0, 400)
    return { imgs, asides, body }
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 2))
ws.close()
process.exit(0)
