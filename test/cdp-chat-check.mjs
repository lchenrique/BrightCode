// Check the chat surface layout and scroll behavior.
import { setTimeout as wait } from 'node:timers/promises'
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
  const out = join(SHOTS, 'chat-' + label + '.png')
  await writeFile(out, Buffer.from(data, 'base64'))
  return out
}

// First, let's see what tasks exist and what view we're on
const before = await ev(`(function() {
  function rect(el) {
    if (!el) return null
    var r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
  }
  var chat = document.querySelector('[data-editor-group="chat"]')
  var messageList = chat ? chat.querySelector('.chat-scrollbar') : null
  var composer = document.querySelector('[data-chat-composer]')
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    chatWrapper: rect(chat),
    chatWrapperDisplay: chat ? getComputedStyle(chat).display : null,
    chatWrapperOverflow: chat ? getComputedStyle(chat).overflow : null,
    chatWrapperClasses: chat ? chat.className : null,
    messageList: rect(messageList),
    messageListOverflow: messageList ? getComputedStyle(messageList).overflowY : null,
    messageListScrollHeight: messageList ? messageList.scrollHeight : null,
    messageListClientHeight: messageList ? messageList.clientHeight : null,
    composer: rect(composer),
    welcome: !!document.querySelector('[data-welcome-screen]'),
  })
})()`)
console.log('BEFORE NAV:', before)

// Try clicking the New task button in sidebar to get to a chat
const clicked = await ev(`(function() {
  var btn = document.querySelector('button[aria-label*="New task" i], a[href*="new" i]') ||
             Array.from(document.querySelectorAll('button')).find(b => /new task/i.test(b.textContent))
  if (!btn) return 'no new task button found'
  btn.click()
  return 'clicked: ' + btn.textContent.trim()
})()`)
console.log('CLICK:', clicked)
await wait(2000)

const after = await ev(`(function() {
  function rect(el) {
    if (!el) return null
    var r = el.getBoundingClientRect()
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }
  }
  var chat = document.querySelector('[data-editor-group="chat"]')
  var messageList = chat ? chat.querySelector('.chat-scrollbar') : null
  var composer = document.querySelector('[data-chat-composer]')
  return JSON.stringify({
    viewport: { w: window.innerWidth, h: window.innerHeight },
    chatWrapper: rect(chat),
    chatWrapperDisplay: chat ? getComputedStyle(chat).display : null,
    chatWrapperOverflow: chat ? getComputedStyle(chat).overflow : null,
    messageList: rect(messageList),
    messageListOverflow: messageList ? getComputedStyle(messageList).overflowY : null,
    messageListScrollHeight: messageList ? messageList.scrollHeight : null,
    messageListClientHeight: messageList ? messageList.clientHeight : null,
    composer: rect(composer),
    welcome: !!document.querySelector('[data-welcome-screen]'),
  })
})()`)
console.log('AFTER NAV:', after)
await shot('current')
ws.close()
