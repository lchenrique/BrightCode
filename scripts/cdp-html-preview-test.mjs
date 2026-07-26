/**
 * Focused smoke test for HTML Preview/Code/Split in the task workspace.
 * It only reads an existing HTML file.
 */

import { mkdir, writeFile } from 'node:fs/promises'

const progressPath = 'D:\\tmp\\brightcode-html-test\\progress.txt'
await mkdir('D:\\tmp\\brightcode-html-test', { recursive: true })
const mark = (message) => writeFile(progressPath, message, 'utf-8')
await mark('starting')

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://localhost'),
)
if (!page) throw new Error('No BrightCode renderer found.')

const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
await mark('websocket connected')
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id || !pending.has(message.id)) return
  pending.get(message.id)(message.result || message.error)
  pending.delete(message.id)
})
const send = (method, params = {}) => {
  const messageId = ++id
  socket.send(JSON.stringify({ id: messageId, method, params }))
  return new Promise((resolve) => pending.set(messageId, resolve))
}
const evaluate = (expression) =>
  send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

await send('Runtime.enable')
await send('Page.enable')
await mark('runtime enabled')

const taskTitle = await evaluate(`(async () => {
  const projects = await window.electronAPI.projects.list()
  const tasks = await window.electronAPI.tasks.list()
  const project = projects.find((item) =>
    tasks.some((task) => task.projectId === item.id)
  )
  return tasks.find((task) => task.projectId === project?.id)?.title ?? null
})()`)
if (!taskTitle.result?.value) throw new Error('No project task was found.')
await mark('task found')

const taskSelected = await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
  const task = buttons.find(
    (button) => button.textContent?.trim() === ${JSON.stringify(taskTitle.result.value)}
  )
  task?.click()
  return Boolean(task)
})()`)
if (!taskSelected.result?.value) throw new Error('Task could not be selected.')
await mark('task selected')
await wait(700)

await evaluate(`(() => {
  const folder = document.querySelector('button[aria-label="Open project files"]')
  if (folder?.getAttribute('aria-pressed') !== 'true') folder?.click()
})()`)
await wait(900)
await mark('explorer opened')

const htmlPath = await evaluate(`(() => {
  const explorer = document.querySelector('aside[aria-label="Project file explorer"]')
  const html = Array.from(explorer?.querySelectorAll('button[title]') ?? [])
    .find((button) => /\\.html?$/i.test(button.getAttribute('title') ?? ''))
  html?.click()
  return html?.getAttribute('title') ?? null
})()`)
if (!htmlPath.result?.value) throw new Error('No HTML file was found.')
await mark(`html selected: ${htmlPath.result.value}`)
await wait(900)
await evaluate(
  `document.querySelector('[data-html-editor] button[title="Preview HTML document"]')?.click()`,
)
await wait(250)

const inspect = () =>
  evaluate(`(() => {
    const editor = document.querySelector('[data-html-editor]')
    const frame = editor?.querySelector('iframe')
    return {
      mode: editor?.getAttribute('data-view-mode') ?? null,
      iframeCount: editor?.querySelectorAll('iframe').length ?? 0,
      monacoEditors: editor?.querySelectorAll('.monaco-editor').length ?? 0,
      sandboxed: frame?.getAttribute('sandbox') === 'allow-scripts',
      sourceLength: frame?.getAttribute('srcdoc')?.length ?? 0,
      buttons: Array.from(editor?.querySelectorAll('[role="group"] button') ?? [])
        .map((button) => button.textContent?.trim()),
    }
  })()`)

const preview = (await inspect()).result?.value
await mark('preview inspected')
console.log('HTML preview:', preview)

await evaluate(
  `document.querySelector('[data-html-editor] button[title="Edit and preview side by side"]')?.click()`,
)
await wait(900)
const split = (await inspect()).result?.value
await mark('split inspected')
console.log('HTML split:', split)

const failures = [
  preview?.mode !== 'preview',
  preview?.iframeCount !== 1,
  preview?.monacoEditors !== 0,
  !preview?.sandboxed,
  preview?.sourceLength < 1,
  preview?.buttons?.join('|') !== 'Code|Preview|Split',
  split?.mode !== 'split',
  split?.iframeCount !== 1,
  split?.monacoEditors !== 1,
]
if (failures.some(Boolean)) {
  console.error('HTML preview smoke test failed.')
  process.exit(1)
}

console.log('HTML preview smoke test passed.')
await mark('passed')
socket.close()
process.exit(0)
