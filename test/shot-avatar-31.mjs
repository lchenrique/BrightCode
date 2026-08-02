// Screenshot the sidebar agent avatar (should be the 31.svg pixel robot)
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', 'scripts', 'screenshots')
await mkdir(SHOTS, { recursive: true })

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
await send('Runtime.enable')
await wait(1500)

// find avatar img and its box
const info = await send('Runtime.evaluate', {
  expression: `(() => {
    const img = document.querySelector('img[src="/agent-avatar.png"]')
    if (!img) return { found: false }
    const r = img.getBoundingClientRect()
    return { found: true, x: r.x, y: r.y, w: r.width, h: r.height, src: img.src }
  })()`,
  returnByValue: true,
})
console.log('avatar info:', JSON.stringify(info.result.value))
const { x, y, w, h } = info.result.value
if (!info.result.value.found) {
  console.log('AVATAR NOT FOUND — dumping sidebar imgs:')
  const imgs = await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('aside img, nav img')].map(i => i.src)`,
    returnByValue: true,
  })
  console.log(JSON.stringify(imgs.result.value))
}

const pad = 20
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: {
    x: Math.max(0, x - pad),
    y: Math.max(0, y - pad),
    width: w + pad * 2,
    height: h + pad * 2,
    scale: 1,
  },
})
await writeFile(join(SHOTS, 'avatar-31-sidebar.png'), Buffer.from(shot.data, 'base64'))

// full sidebar shot for context
const full = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(join(SHOTS, 'avatar-31-full.png'), Buffer.from(full.data, 'base64'))

console.log('saved')
ws.close()
process.exit(0)
