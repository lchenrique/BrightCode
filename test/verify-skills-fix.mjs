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
const exceptions = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
  } else if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails?.exception?.description?.slice(0, 300) ?? '')
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
await send('Page.reload', { ignoreCache: true })
await wait(6000)

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
    const found = btns.filter(b => b.textContent.trim() === 'Skills')
    found.forEach(b => b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
    return { matched: found.length, texts: btns.slice(0, 15).map(b => b.textContent.trim().slice(0, 24)) }
  })()`,
  returnByValue: true,
})
console.log('click:', JSON.stringify(r.result.value))

let state = null
for (let i = 0; i < 10; i++) {
  await wait(800)
  const s = await send('Runtime.evaluate', {
    expression: `(() => ({ skillsLib: document.body.innerText.includes('Skills Library'), text: document.body.innerText.slice(0, 180) }))()`,
    returnByValue: true,
  })
  state = s.result.value
  if (state.skillsLib) break
}
console.log('final state:', JSON.stringify(state))
const shot = await send('Page.captureScreenshot', { format: 'png' })
await writeFile(join(SHOTS, 'skills-page-fixed.png'), Buffer.from(shot.data, 'base64'))
console.log('exceptions:', exceptions.length ? exceptions.slice(0, 3) : 'none')
ws.close()
process.exit(0)
