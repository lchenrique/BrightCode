// Quick CDP check: what zoom factor is the Electron webContents at right
// now, and what does the welcome heading look like? Used to validate the
// setZoomFactor fix is actually applied after reload.

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = targets.find((x) => x.type === 'page')
if (!t) {
  console.error('No page target found')
  process.exit(1)
}
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

async function ev(expr, awaitPromise = false) {
  const res = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
  return res.result.value
}

const result = await ev(`(() => {
  const stored = localStorage.getItem('brightcode:font-scale')
  const heading = document.querySelector('h1')
  const headingText = heading?.textContent?.trim() ?? null
  const headingRect = heading?.getBoundingClientRect()
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight
  const html = document.documentElement
  return JSON.stringify({
    storedFontScale: stored,
    headingText,
    headingRect: headingRect && {
      left: Math.round(headingRect.left),
      right: Math.round(headingRect.right),
      width: Math.round(headingRect.width),
      top: Math.round(headingRect.top),
      bottom: Math.round(headingRect.bottom),
    },
    headingClipped: headingRect ? (headingRect.right > viewportW || headingRect.left < 0) : null,
    viewport: { w: viewportW, h: viewportH },
    devicePixelRatio: window.devicePixelRatio,
    rootTransform: getComputedStyle(document.getElementById('root')).transform,
    rootWidth: document.getElementById('root').offsetWidth,
    fontScaleVar: getComputedStyle(document.getElementById('root')).getPropertyValue('--font-scale'),
  })
})()`)

console.log(result)

ws.close()
