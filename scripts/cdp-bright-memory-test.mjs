/** Open Bright Memory from the sidebar and capture its setup status view. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((target) =>
  target.type === 'page' && target.url && !target.url.includes('devtools'),
)
if (!page) {
  console.error('No main page target')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  pending.get(message.id)(message.result || message.error)
  pending.delete(message.id)
})
const send = (method, params) => {
  const requestId = ++id
  socket.send(JSON.stringify({ id: requestId, method, params }))
  return new Promise((resolve) => pending.set(requestId, resolve))
}
const evaluate = (expression) => send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
})
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

await send('Page.enable', {})
await send('Runtime.enable', {})
await sleep(600)

const opened = await evaluate(`(() => {
  const item = Array.from(document.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === 'Bright Memory')
  if (!item) return { ok: false, reason: 'menu item missing' }
  item.click()
  return { ok: true }
})()`)
if (!opened.result?.value?.ok) {
  console.error('Could not open Bright Memory', opened.result?.value)
  process.exit(1)
}

await sleep(1_000)
const visible = await evaluate(`Boolean(document.querySelector('[data-testid="bright-memory-view"]'))`)
if (!visible.result?.value) {
  console.error('Bright Memory view did not render')
  process.exit(1)
}

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const outputDirectory = join(process.cwd(), 'scripts', 'screenshots')
mkdirSync(outputDirectory, { recursive: true })
const output = join(outputDirectory, 'bright-memory-01-status.png')
writeFileSync(output, Buffer.from(screenshot.data, 'base64'))
console.log('Saved', output)

if (process.env.BRIGHT_MEMORY_CDP_INSTALL === '1') {
  const started = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="bright-memory-install"]')
    if (!button) return { ok: false, reason: 'already configured or button missing' }
    button.click()
    return { ok: true }
  })()`)
  if (started.result?.value?.ok) {
    let ready = false
    for (let attempt = 0; attempt < 180; attempt += 1) {
      await sleep(1_000)
      const state = await evaluate(`document.body.textContent?.includes('Bright Memory is ready')`)
      if (state.result?.value) {
        ready = true
        break
      }
    }
    if (!ready) {
      const error = await evaluate(`document.querySelector('[role="alert"]')?.textContent ?? ''`)
      console.error('Installation did not become ready', error.result?.value)
      process.exit(1)
    }
    const readyScreenshot = await send('Page.captureScreenshot', { format: 'png' })
    const readyOutput = join(outputDirectory, 'bright-memory-02-ready.png')
    writeFileSync(readyOutput, Buffer.from(readyScreenshot.data, 'base64'))
    console.log('Saved', readyOutput)
  } else {
    console.log('Install skipped:', started.result?.value?.reason)
  }
}

console.log('OK')
socket.close()
