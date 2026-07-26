/**
 * Smoke test for the task workspace. Requires `npm run electron:dev`.
 * It uses an existing project task and does not edit files on disk.
 */

import { mkdir, writeFile } from 'node:fs/promises'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://localhost'),
)
if (!page) {
  console.error('No BrightCode renderer found.')
  process.exit(1)
}

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
    return
  }
  if (!message.id || !pending.has(message.id)) return
  pending.get(message.id)(message.result || message.error)
  pending.delete(message.id)
})

const send = (method, params) => {
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

await send('Runtime.enable', {})
await send('Page.enable', {})
await wait(800)
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
  code: 'Escape',
  key: 'Escape',
})
await evaluate(`document.querySelector('#assistant-working-preview')?.remove()`)

const contextResult = await evaluate(`(async () => {
  const projects = await window.electronAPI.projects.list()
  const tasks = await window.electronAPI.tasks.list()
  const project = projects.find((item) => /BrightCode$/i.test(item.path))
    ?? projects.find((item) => tasks.some((task) => task.projectId === item.id))
  const task = project
    ? tasks.find((item) => item.projectId === project.id)
    : null
  return project && task
    ? { project: { id: project.id, label: project.label }, task: { id: task.id, title: task.title } }
    : null
})()`)
const context = contextResult.result?.value
if (!context) {
  console.error('No existing project task is available for the workspace smoke test.')
  process.exit(1)
}
console.log('Test context:', JSON.stringify(context))

const selected = await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
  const taskButton = buttons.find((button) => button.textContent?.trim() === ${JSON.stringify(context.task.title)})
  if (!taskButton) return false
  taskButton.click()
  return true
})()`)
if (!selected.result?.value) {
  console.error(`Could not select task: ${context.task.title}`)
  process.exit(1)
}
await wait(700)

const opened = await evaluate(`(() => {
  const folder = document.querySelector('button[aria-label="Open project files"]')
  if (!folder) return false
  if (folder.getAttribute('aria-pressed') !== 'true') folder.click()
  return true
})()`)
if (!opened.result?.value) {
  console.error('Project folder button was not found.')
  process.exit(1)
}
await wait(1200)

const firstFiles = await evaluate(`(() => {
  const aside = document.querySelector('aside[aria-label="Project file explorer"]')
  if (!aside || getComputedStyle(aside).display === 'none') return { ok: false }
  const candidates = ['package.json', 'README.md', 'src']
  const found = candidates.filter((path) => aside.querySelector('button[title="' + path + '"]'))
  const firstFile = found.find((path) => path !== 'src')
  if (firstFile) aside.querySelector('button[title="' + firstFile + '"]').click()
  return { ok: true, found, firstFile }
})()`)
if (!firstFiles.result?.value?.ok || !firstFiles.result.value.firstFile) {
  const diagnostics = await evaluate(`(() => {
    const aside = document.querySelector('aside[aria-label="Project file explorer"]')
    return {
      text: aside?.textContent?.slice(0, 600),
      titles: Array.from(aside?.querySelectorAll('button[title]') ?? [])
        .map((button) => button.getAttribute('title'))
        .slice(0, 40),
    }
  })()`)
  console.error(
    'The file tree opened, but no test file was found.',
    firstFiles.result?.value,
    diagnostics.result?.value,
  )
  process.exit(1)
}
await wait(1800)

const secondFile = await evaluate(`(() => {
  const aside = document.querySelector('aside[aria-label="Project file explorer"]')
  const treeFiles = Array.from(aside?.querySelectorAll('button[title]') ?? [])
    .filter((button) => /\\.[a-z0-9]+$/i.test(button.getAttribute('title') ?? ''))
  const second = treeFiles.find(
    (button) => button.getAttribute('title') !== ${JSON.stringify(firstFiles.result.value.firstFile)}
  )
  second?.click()
  return second?.getAttribute('title') ?? null
})()`)
console.log('Second file:', secondFile.result?.value)
await wait(1200)

const inspect = async () => {
  const result = await evaluate(`(() => {
    const aside = document.querySelector('aside[aria-label="Project file explorer"]')
    const tabButtons = Array.from(document.querySelectorAll('[role="tab"][title]'))
    const folder = document.querySelector('button[aria-label="Open project files"]')
    const panel = document.querySelector('button[aria-label="Toggle project file explorer"]')
    const chatInput = document.querySelector('textarea[placeholder*="message"]')
    const tabList = document.querySelector('[role="tablist"]')
    const header = document.querySelector('main header')
    return {
      asideDisplay: aside ? getComputedStyle(aside).display : null,
      asideWidth: aside?.getBoundingClientRect().width ?? 0,
      explorerVisible: Boolean(aside && getComputedStyle(aside).display !== 'none'),
      resizeHandle: Boolean(document.querySelector('[aria-label="Resize project file explorer"]')),
      tabTitles: tabButtons.map((button) => button.getAttribute('title')),
      conversationTab: Boolean(document.querySelector(
        '[role="tab"][aria-label^="Conversation:"]'
      )),
      conversationTabActive: document.querySelector(
        '[role="tab"][aria-label^="Conversation:"]'
      )?.getAttribute('aria-selected'),
      monacoEditors: document.querySelectorAll('.monaco-editor').length,
      chatMounted: Boolean(chatInput),
      chatVisible: Boolean(chatInput?.offsetParent),
      unifiedHeader: Boolean(header && tabList && header.contains(tabList)),
      tabOverflowY: tabList ? getComputedStyle(tabList).overflowY : null,
      tabScrollHeight: tabList?.scrollHeight ?? 0,
      tabClientHeight: tabList?.clientHeight ?? 0,
      folderPressed: folder?.getAttribute('aria-pressed'),
      panelPressed: panel?.getAttribute('aria-pressed'),
    }
  })()`)
  return result.result?.value
}

const initial = await inspect()
console.log('Workspace open:', JSON.stringify(initial, null, 2))

const resizePoint = await evaluate(`(() => {
  const handle = document.querySelector('[aria-label="Resize project file explorer"]')
  const rect = handle?.getBoundingClientRect()
  return rect ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : null
})()`)
if (resizePoint.result?.value) {
  const { x, y } = resizePoint.result.value
  const resizeDelta = initial.asideWidth >= 500 ? 40 : -40
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x + resizeDelta,
    y,
    button: 'left',
    buttons: 1,
  })
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: x + resizeDelta,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
}
await wait(250)
const resized = await inspect()
console.log('Explorer resized:', initial.asideWidth, '->', resized.asideWidth)

await evaluate(`document.querySelector('[role="tab"]')?.click()`)
await wait(250)
const chatSelected = await inspect()
console.log('Chat selected:', JSON.stringify(chatSelected, null, 2))

const tabSwitch = await evaluate(`(() => {
  const tabs = Array.from(document.querySelectorAll('[role="tab"][title]'))
  tabs[0]?.click()
  return tabs[0]?.getAttribute('title') ?? null
})()`)
await wait(250)
const switchedPath = await evaluate(`(() => {
  return document.querySelector('span.font-mono')?.textContent?.trim() ?? null
})()`)
await evaluate(`(() => {
  const tabs = Array.from(document.querySelectorAll('[role="tab"][title]'))
  tabs.at(-1)?.click()
})()`)
await wait(250)
console.log('Tab switch:', tabSwitch.result?.value, '->', switchedPath.result?.value)

await evaluate(`document.querySelector('.monaco-editor textarea')?.focus()`)
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  modifiers: 2,
  windowsVirtualKeyCode: 83,
  nativeVirtualKeyCode: 83,
  code: 'KeyS',
  key: 's',
})
await send('Input.dispatchKeyEvent', {
  type: 'keyUp',
  modifiers: 2,
  windowsVirtualKeyCode: 83,
  nativeVirtualKeyCode: 83,
  code: 'KeyS',
  key: 's',
})
await wait(350)
const savedByShortcut = await evaluate(`(() => {
  return /saved/i.test(document.querySelector('main')?.textContent ?? '')
})()`)
console.log('Ctrl+S saved:', savedByShortcut.result?.value)

await evaluate(`document.querySelector('button[aria-label="Open project files"]')?.click()`)
await wait(200)
const explorerClosed = await inspect()
console.log('Explorer closed:', JSON.stringify(explorerClosed, null, 2))

await evaluate(`document.querySelector('button[aria-label="Toggle project file explorer"]')?.click()`)
await wait(400)
const restored = await inspect()
console.log('Explorer restored by panel toggle:', JSON.stringify(restored, null, 2))

const topProjectMenu = await evaluate(`(async () => {
  const trigger = document.querySelector('button[aria-label="Choose how to open the project"]')
  trigger?.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerType: 'mouse',
  }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  return Array.from(document.querySelectorAll('[role="menuitem"]'))
    .map((item) => item.textContent?.trim())
})()`)
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
  code: 'Escape',
  key: 'Escape',
})
await wait(100)
console.log('Top project menu:', topProjectMenu.result?.value)

const explorerProjectMenu = await evaluate(`(async () => {
  const trigger = document.querySelector('button[aria-label="Project actions"]')
  trigger?.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerType: 'mouse',
  }))
  await new Promise((resolve) => setTimeout(resolve, 150))
  return Array.from(document.querySelectorAll('[role="menuitem"]'))
    .map((item) => item.textContent?.trim())
})()`)
await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
  code: 'Escape',
  key: 'Escape',
})
await wait(100)
console.log('Explorer project menu:', explorerProjectMenu.result?.value)

const autoRefreshObserved = await evaluate(`(() => new Promise((resolve) => {
  const button = document.querySelector('button[aria-label="Refresh project files"]')
  if (!button) {
    resolve(false)
    return
  }
  let observed = button.hasAttribute('disabled')
  const observer = new MutationObserver(() => {
    if (button.hasAttribute('disabled')) observed = true
  })
  observer.observe(button, { attributes: true, attributeFilter: ['disabled'] })
  window.dispatchEvent(new CustomEvent('brightcode:project-files-changed', {
    detail: { projectId: ${JSON.stringify(context.project.id)}, path: 'README.md' },
  }))
  setTimeout(() => {
    observer.disconnect()
    resolve(observed)
  }, 700)
}) )()`)
console.log('Automatic Explorer refresh observed:', autoRefreshObserved.result?.value)

const failures = [
  initial.asideDisplay !== 'flex',
  initial.tabTitles.length < 2,
  initial.monacoEditors !== 1,
  !initial.chatMounted,
  !initial.conversationTab,
  !initial.unifiedHeader,
  initial.tabOverflowY !== 'hidden',
  initial.tabScrollHeight !== initial.tabClientHeight,
  !initial.resizeHandle,
  Math.abs(resized.asideWidth - initial.asideWidth) < 20,
  !chatSelected.chatVisible,
  chatSelected.conversationTabActive !== 'true',
  chatSelected.monacoEditors !== 1,
  switchedPath.result?.value !== tabSwitch.result?.value,
  !savedByShortcut.result?.value,
  explorerClosed.explorerVisible,
  explorerClosed.tabTitles.length !== initial.tabTitles.length,
  restored.asideDisplay !== 'flex',
  !restored.explorerVisible,
  Math.abs(restored.asideWidth - resized.asideWidth) > 1,
  restored.tabTitles.length !== initial.tabTitles.length,
  topProjectMenu.result?.value?.length !== 4,
  explorerProjectMenu.result?.value?.length !== 4,
  !autoRefreshObserved.result?.value,
]
const monacoServiceErrors = exceptions.filter((exception) =>
  exception?.exception?.description?.includes('UNKNOWN service'),
)
console.log('Monaco service errors:', monacoServiceErrors.length)
failures.push(monacoServiceErrors.length > 0)
if (failures.some(Boolean)) {
  console.error('Workspace smoke test failed.')
  process.exit(1)
}

await evaluate(`(() => {
  const trigger = document.querySelector('button[aria-label="Project actions"]')
  trigger?.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerType: 'mouse',
  }))
})()`)
await wait(150)
const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const outputDirectory = 'D:\\tmp\\brightcode-workspace-test'
const outputPath = `${outputDirectory}\\workspace.png`
await mkdir(outputDirectory, { recursive: true })
await writeFile(outputPath, Buffer.from(screenshot.data, 'base64'))

await send('Input.dispatchKeyEvent', {
  type: 'keyDown',
  windowsVirtualKeyCode: 27,
  nativeVirtualKeyCode: 27,
  code: 'Escape',
  key: 'Escape',
})
const workingIndicator = await evaluate(`(async () => {
 try {
  const [{ AssistantTurn }, ReactModule, ReactDOMModule] = await Promise.all([
    import('/src/components/chat/AssistantTurn.tsx'),
    import('/node_modules/.vite/deps/react.js'),
    import('/node_modules/.vite/deps/react-dom_client.js'),
  ])
  const React = ReactModule.default ?? ReactModule
  const ReactDOM = ReactDOMModule.default ?? ReactDOMModule
  const host = document.createElement('div')
  host.id = 'assistant-working-preview'
  Object.assign(host.style, {
    position: 'fixed',
    left: '520px',
    top: '250px',
    zIndex: '99999',
    width: '420px',
    padding: '20px',
    borderRadius: '12px',
    border: '1px solid var(--border)',
    background: 'var(--background)',
    boxShadow: '0 16px 48px rgba(0, 0, 0, .4)',
  })
  document.body.append(host)
  ReactDOM.createRoot(host).render(React.createElement(AssistantTurn, {
    assistant: {
      id: 'working-preview',
      role: 'assistant',
      content: '',
      streaming: true,
    },
    toolMessages: [],
    streaming: true,
  }))
  await new Promise((resolve) => setTimeout(resolve, 500))
  const bot = host.querySelector('.assistant-working-bot')
  return {
    statuses: host.querySelectorAll('[role="status"]').length,
    bots: host.querySelectorAll('.assistant-working-bot').length,
    animationName: bot ? getComputedStyle(bot).animationName : null,
  }
 } catch (error) {
   return { error: error instanceof Error ? error.stack : String(error) }
 }
})()`)
console.log('Animated working bot:', workingIndicator.result?.value)
if (
  workingIndicator.result?.value?.statuses !== 1 ||
  workingIndicator.result?.value?.bots !== 1 ||
  workingIndicator.result?.value?.animationName !== 'assistant-working-bot'
) {
  console.error('Animated working bot smoke test failed.')
  process.exit(1)
}
await wait(250)
const workingScreenshot = await send('Page.captureScreenshot', { format: 'png' })
const workingOutputPath = `${outputDirectory}\\working-indicator.png`
await writeFile(workingOutputPath, Buffer.from(workingScreenshot.data, 'base64'))
await evaluate(`document.querySelector('#assistant-working-preview')?.remove()`)

console.log(
  `Workspace smoke test passed. Screenshots: ${outputPath}, ${workingOutputPath}`,
)
socket.close()
