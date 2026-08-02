import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', 'scripts', 'screenshots')
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
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
await send('Page.enable')
await wait(1200)
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(join(SHOTS, 'avatar-31-full.png'), Buffer.from(shot.data, 'base64'))
console.log('saved full')
ws.close()
process.exit(0)
