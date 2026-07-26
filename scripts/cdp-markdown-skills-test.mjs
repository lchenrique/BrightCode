/**
 * Visual smoke test for the shared Markdown editor in Skills.
 * It opens an existing skill but never changes or saves its content.
 */

const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://localhost'),
)
if (!page) throw new Error('No BrightCode renderer found.')

const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const exceptions = []
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params?.exceptionDetails)
  }
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
await evaluate(`document.querySelector('#assistant-working-preview')?.remove()`)
console.log('Connected to BrightCode renderer.')

const skillsOpened = await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
  const skills = buttons.find((button) => button.textContent?.trim() === 'Skills')
  skills?.click()
  return Boolean(skills)
})()`)
if (!skillsOpened.result?.value) throw new Error('Skills navigation was not found.')
console.log('Skills view opened.')

let cardFound = false
for (let attempt = 0; attempt < 20; attempt += 1) {
  await wait(250)
  const result = await evaluate(
    `Boolean(document.querySelector('main .group.cursor-pointer'))`,
  )
  if (result.result?.value) {
    cardFound = true
    break
  }
}
if (!cardFound) throw new Error('No discovered skill card was rendered.')
console.log('Skill card found.')

await evaluate(`document.querySelector('main .group.cursor-pointer')?.click()`)

let editorFound = false
for (let attempt = 0; attempt < 20; attempt += 1) {
  await wait(250)
  const result = await evaluate(
    `Boolean(document.querySelector('[data-markdown-editor]'))`,
  )
  if (result.result?.value) {
    editorFound = true
    break
  }
}
if (!editorFound) throw new Error('The Markdown skill editor did not render.')
console.log('Skill editor opened.')

const inspect = () =>
  evaluate(`(() => {
    const editor = document.querySelector('[data-markdown-editor]')
    const drawer = editor?.closest('aside')
    const modeGroup = drawer?.querySelector('[role="group"][aria-label="Markdown view"]')
    const header = modeGroup?.parentElement
    const save = Array.from(drawer?.querySelectorAll('button') ?? [])
      .find((button) => /Saved|Save/.test(button.textContent ?? ''))
    return {
      mode: editor?.getAttribute('data-view-mode') ?? null,
      drawerWidth: drawer?.getBoundingClientRect().width ?? 0,
      headerHeight: header?.getBoundingClientRect().height ?? 0,
      resizeHandle: Boolean(drawer?.querySelector('[aria-label="Resize skill editor"]')),
      embeddedToolbar: Boolean(editor?.querySelector('[role="group"]')),
      buttons: Array.from(modeGroup?.querySelectorAll('button') ?? [])
        .map((button) => button.textContent?.trim()),
      monacoEditors: editor?.querySelectorAll('.monaco-editor').length ?? 0,
      saveDisabled: save?.hasAttribute('disabled') ?? false,
      renderedHeadings: editor?.querySelectorAll('h1, h2, h3').length ?? 0,
    }
  })()`)

const preview = (await inspect()).result?.value
console.log('Skill Markdown preview:', preview)

const resizedByKeyboard = await evaluate(`(() => {
  const handle = document.querySelector('[aria-label="Resize skill editor"]')
  const drawer = document.querySelector('aside[aria-label="Skill editor"]')
  if (!handle || !drawer) return null
  const before = drawer.getBoundingClientRect().width
  handle.dispatchEvent(new KeyboardEvent('keydown', {
    key: before >= 570 ? 'ArrowRight' : 'ArrowLeft',
    bubbles: true,
    cancelable: true,
  }))
  return before
})()`)
if (!resizedByKeyboard.result?.value) {
  throw new Error('Skill resize handle was not found.')
}
const initialDrawerWidth = resizedByKeyboard.result.value
await wait(250)
const resized = (await inspect()).result?.value
console.log('Skill editor resized:', initialDrawerWidth, '->', resized?.drawerWidth)

await evaluate(
  `document.querySelector('aside[aria-label="Skill editor"] button[title="Edit and preview side by side"]')?.click()`,
)
await wait(1000)
const split = (await inspect()).result?.value
console.log('Skill Markdown split:', split)

await evaluate(
  `(() => {
    const buttons = Array.from(document.querySelectorAll(
      'aside[aria-label="Skill editor"] [role="group"] button'
    ))
    buttons.find((button) => button.textContent?.trim() === 'Code')?.click()
  })()`,
)
await wait(600)
const code = (await inspect()).result?.value
console.log('Skill Markdown code:', code)

await evaluate(
  `(() => {
    const buttons = Array.from(document.querySelectorAll(
      'aside[aria-label="Skill editor"] [role="group"] button'
    ))
    buttons.find((button) => button.textContent?.trim() === 'Formatted')?.click()
  })()`,
)
await wait(300)
const formattedAgain = (await inspect()).result?.value
console.log('Skill Markdown formatted again:', formattedAgain)

const failures = [
  preview?.mode !== 'preview',
  preview?.buttons?.length !== 3,
  !preview?.saveDisabled,
  preview?.drawerWidth < 420,
  preview?.headerHeight !== 48,
  !preview?.resizeHandle,
  preview?.embeddedToolbar,
  Math.abs((resized?.drawerWidth ?? 0) - initialDrawerWidth) < 15,
  split?.mode !== 'split',
  split?.monacoEditors !== 1,
  code?.mode !== 'code',
  code?.monacoEditors !== 1,
  formattedAgain?.mode !== 'preview',
  formattedAgain?.monacoEditors !== 0,
  exceptions.length > 0,
]
if (failures.some(Boolean)) {
  console.error('Markdown Skills smoke test failed.', { exceptions })
  process.exit(1)
}

console.log('Markdown Skills smoke test passed.')
socket.close()
process.exit(0)
