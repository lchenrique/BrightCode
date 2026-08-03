// Measure layout of the current view.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

await send('Runtime.enable')
await send('Page.enable')

async function ev(expr) {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

async function shot(label) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const out = join(SHOTS, 'layout-' + label + '.png')
  await writeFile(out, Buffer.from(data, 'base64'))
  return out
}

const expr = `(function() {
  function rect(el) {
    if (!el) return null
    var r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
  }
  var welcome = document.querySelector('[data-welcome-screen]')
  var composer = document.querySelector('[data-chat-composer]')
  var heading = document.querySelector('h1')
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    welcome: rect(welcome),
    composer: rect(composer),
    heading: rect(heading),
    composerBottomRatio: composer ? composer.getBoundingClientRect().bottom / window.innerHeight : null,
    main: rect(document.querySelector('main')),
    root: rect(document.getElementById('root'))
  })
})()`

console.log(await ev(expr))
await shot('current')
ws.close()
