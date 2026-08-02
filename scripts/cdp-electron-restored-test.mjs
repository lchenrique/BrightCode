import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const HOST = 'http://127.0.0.1:9222'
const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'screenshots')
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7) ?? 'dev'
const expectedScheme = mode === 'packaged' ? 'file://' : 'http://localhost'
await mkdir(SHOTS, { recursive: true })

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find(
  (target) => target.type === 'page'
    && target.title === 'BrightCode'
    && target.url.startsWith(expectedScheme),
)
if (!page) throw new Error(`No BrightCode ${mode} renderer found; expected ${expectedScheme}`)
console.log(`Renderer: ${page.url}`)

const socket = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const exceptions = []
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data.toString())
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text)
    return
  }
  if (!message.id || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) reject(new Error(message.error.message))
  else resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const commandId = ++id
  pending.set(commandId, { resolve, reject })
  socket.send(JSON.stringify({ id: commandId, method, params }))
})
const evaluate = async (expression, awaitPromise = false) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}
const screenshot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  const path = join(SHOTS, name)
  await writeFile(path, Buffer.from(result.data, 'base64'))
  return path
}

await send('Runtime.enable')
await send('Page.enable')
for (let attempt = 0; attempt < 30; attempt++) {
  if (await evaluate(`document.getElementById('root')?.children.length > 0`)) break
  await wait(250)
}

const fixtureTitle = `Electron restored smoke ${Date.now()}`
let fixture = null

try {
  fixture = await evaluate(`(async () => {
    const existing = await window.electronAPI.projects.list()
    const unexpected = existing.filter((item) => !(
      item.label === 'Default Project'
      && /BrightCodeProjects[\\/]DefaultProject$/i.test(item.path)
    ))
    if (unexpected.length > 0) {
      return { error: 'Smoke profile contains pre-existing projects: ' + unexpected.map((item) => item.path).join(', ') }
    }
    const originalActive = existing.length > 0 ? await window.electronAPI.projects.getActive() : null
    let project = existing.find((item) => /BrightCode$/i.test(item.path))
    let projectCreated = false
    if (!project) {
      const added = await window.electronAPI.projects.add(${JSON.stringify(join(HERE, '..'))}, 'BrightCode smoke')
      if (!added.ok) return { error: added.error }
      project = added.project
      projectCreated = true
    }
    await window.electronAPI.projects.setActive(project.id)
    const agent = await window.electronAPI.agents.add({
      name: 'Electron Smoke Agent',
      avatarSeed: 'electron-restored-smoke',
      description: 'Temporary isolated-profile smoke fixture',
      systemPrompt: 'Validate the Electron UI.',
      model: 'minimax/MiniMax-M3',
      tools: [],
      enabled: true,
    })
    const task = await window.electronAPI.tasks.create({ projectId: project.id, title: ${JSON.stringify(fixtureTitle)} })
    const searchTaskIds = []
    for (let index = 0; index < 30; index++) {
      const searchTask = await window.electronAPI.tasks.create({ projectId: project.id, title: 'Scale Search Fixture ' + String(index).padStart(2, '0') })
      searchTaskIds.push(searchTask.id)
    }
    return {
      projectId: project.id,
      projectCreated,
      originalProjectId: originalActive?.id ?? null,
      agentId: agent.id,
      taskId: task.id,
      searchTaskIds,
    }
  })()`, true)
  assert(fixture && !fixture.error, `Could not create isolated-profile fixtures: ${fixture?.error ?? 'unknown error'}`)
  let taskSelected = false
  for (let attempt = 0; attempt < 40; attempt++) {
    taskSelected = await evaluate(`(() => {
      const button = document.querySelector('[data-task-id="' + ${JSON.stringify(fixture.taskId)} + '"]')
      button?.click()
      return Boolean(button)
    })()`)
    if (taskSelected) break
    await wait(250)
  }
  assert(taskSelected, `Task fixture button not found: ${fixture.taskId}`)
  await wait(1000)

  await evaluate(`(() => {
    document.body.style.setProperty('--font-scale', '0.85')
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'New task')?.click()
  })()`)
  await wait(300)
  const newTaskState = await evaluate(`(() => {
    const welcome = document.querySelector('[data-welcome-screen]')
    const composer = welcome?.querySelector('[data-chat-composer]')
    const welcomeRect = welcome?.getBoundingClientRect()
    const rootRect = document.getElementById('root')?.getBoundingClientRect()
    const bodyRect = document.body.getBoundingClientRect()
    return {
      scale: getComputedStyle(document.body).getPropertyValue('--font-scale').trim(),
      welcome: Boolean(welcome),
      composer: Boolean(composer),
      legacyRuntimeInput: Boolean(welcome?.querySelector('textarea[aria-label="Mensagem para o Agent Runtime V2"]')),
      welcomeBottom: welcomeRect?.bottom ?? -1,
      rootBottom: rootRect?.bottom ?? -1,
      bodyBottom: bodyRect.bottom,
      viewportHeight: innerHeight,
    }
  })()`)
  assert(newTaskState.scale === '0.85' && newTaskState.welcome && newTaskState.composer && !newTaskState.legacyRuntimeInput, `New Task did not use the chat composer: ${JSON.stringify(newTaskState)}`)
  assert(Math.abs(newTaskState.welcomeBottom - newTaskState.viewportHeight) < 2 && Math.abs(newTaskState.rootBottom - newTaskState.viewportHeight) < 2 && Math.abs(newTaskState.bodyBottom - newTaskState.viewportHeight) < 2, `New Task did not fill the viewport at 0.85x: ${JSON.stringify(newTaskState)}`)
  const newTaskShot = await screenshot('electron-restored-new-task.png')

  await evaluate(`(() => {
    document.body.style.setProperty('--font-scale', localStorage.getItem('brightcode:font-scale') || '1')
    document.querySelector('[data-task-id="' + ${JSON.stringify(fixture.taskId)} + '"]')?.click()
  })()`)
  await wait(1000)

  const baseState = await evaluate(`(() => {
    const header = document.querySelector('[data-sidebar="header"]')
    const official = Array.from(document.querySelectorAll('[data-avatar-kind="image"]'))
    const agentRows = Array.from(document.querySelectorAll('[data-avatar-kind="dicebear"]'))
    return {
      chatTab: Boolean(document.querySelector('[role="tab"][aria-label^="Conversation:"]')),
      chatSurface: Boolean(document.querySelector('[data-editor-group="chat"] [data-chat-composer]')),
      legacyRuntimeTranscript: Boolean(document.querySelector('[data-agent-runtime-v2="true"]')),
      filesButton: Boolean(document.querySelector('button[aria-label="Open project files"]')),
      terminalButton: Boolean(document.querySelector('button[aria-label="Open new terminal tab"]')),
      systemIcons: document.querySelectorAll('svg.lucide').length,
      officialAvatars: official.length,
      officialInHeader: (() => {
        const image = header?.querySelector('[data-avatar-kind="image"] img[src*="agent-avatar.png"]')
        return Boolean(image?.complete && image.naturalWidth > 0)
      })(),
      dicebearSeeds: agentRows.map((item) => item.getAttribute('data-avatar-seed')),
    }
  })()`)
  console.log('Base state:', JSON.stringify(baseState))
  assert(baseState.chatTab && baseState.chatSurface && !baseState.legacyRuntimeTranscript, `Chat surface missing or legacy transcript active: ${JSON.stringify(baseState)}`)
  assert(baseState.filesButton && baseState.terminalButton, 'Files/terminal controls missing')
  assert(baseState.systemIcons >= 10, `Expected Lucide system icons, found ${baseState.systemIcons}`)
  assert(baseState.officialAvatars === 1 && baseState.officialInHeader, `Official avatar escaped header: ${JSON.stringify(baseState)}`)
  assert(baseState.dicebearSeeds.includes('electron-restored-smoke'), `Agent DiceBear identity missing: ${JSON.stringify(baseState)}`)

  await evaluate(`document.querySelector('button[aria-label="Open project files"]')?.click()`)
  await wait(1200)
  const filesState = await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="Open project files"]')
    const panel = document.querySelector('aside[aria-label="Project file explorer"]')
    const rect = panel?.getBoundingClientRect()
    return {
      buttonDisabled: button?.disabled ?? null,
      buttonPressed: button?.getAttribute('aria-pressed') ?? null,
      panelExists: Boolean(panel),
      panelDisplay: panel ? getComputedStyle(panel).display : null,
      panelWidth: rect?.width ?? 0,
      panelHeight: rect?.height ?? 0,
      tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((tab) => ({
        label: tab.getAttribute('aria-label'),
        selected: tab.getAttribute('aria-selected'),
      })),
      bodyText: (document.body?.innerText ?? '').slice(0, 500),
    }
  })()`)
  filesState.exceptions = [...exceptions]
  const filesVisible = filesState.panelDisplay !== 'none' && filesState.panelWidth > 0 && filesState.panelHeight > 0
  assert(filesVisible, `Files panel did not open: ${JSON.stringify(filesState)}`)
  await evaluate(`document.querySelector('button[aria-label="Open project files"]')?.click()`)
  await wait(250)

  await evaluate(`document.querySelector('button[aria-label="Open new terminal tab"]')?.click()`)
  await wait(1200)
  await evaluate(`document.querySelector('button[aria-label="Open new terminal tab"]')?.click()`)
  await wait(1200)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192, modifiers: 2 })
  await wait(1500)

  const terminalBefore = await evaluate(`(() => {
    const activeTab = document.querySelector('[data-terminal-tab][aria-selected="true"]')
    const activeTerminal = document.querySelector('[data-terminal-instance]:not(.invisible)')
    return {
      tabs: document.querySelectorAll('[data-terminal-tab]').length,
      instances: document.querySelectorAll('[data-terminal-instance]').length,
      textarea: Boolean(activeTerminal?.querySelector('.xterm-helper-textarea')),
      activeTabId: activeTab?.getAttribute('data-terminal-tab') ?? null,
      sessionId: activeTerminal?.getAttribute('data-terminal-session-id') ?? null,
      exits: (document.body.textContent?.match(/Process exited with code/g) ?? []).length,
    }
  })()`)
  assert(terminalBefore.tabs === 3, `Expected 3 terminal tabs, got ${terminalBefore.tabs}`)
  assert(terminalBefore.instances === 3 && terminalBefore.textarea, 'Terminal instances not mounted')
  assert(terminalBefore.exits === 0, 'Terminal exited before command')

  await evaluate(`document.querySelector('[data-terminal-instance]:not(.invisible) .xterm-helper-textarea')?.focus()`)
  const terminalMarker = `BRIGHTCODE_TERMINAL_${Date.now()}`
  const markerSplit = Math.floor(terminalMarker.length / 2)
  const terminalCommand = `Write-Output ('${terminalMarker.slice(0, markerSplit)}' + '${terminalMarker.slice(markerSplit)}')`
  assert(!terminalCommand.includes(terminalMarker), 'Terminal marker leaked into echoed command')
  const outputCaptureReady = await evaluate(`(() => {
    const terminal = document.querySelector('[data-terminal-instance]:not(.invisible)')
    const sessionId = terminal?.getAttribute('data-terminal-session-id')
    if (!sessionId) return false
    window.__electronRestoredTerminalOutput = ''
    window.__electronRestoredRemoveTerminalData?.()
    window.__electronRestoredRemoveTerminalData = window.electronAPI.terminal.onData((event) => {
      if (event.sessionId === sessionId) window.__electronRestoredTerminalOutput += event.data
    })
    window.electronAPI.terminal.write(sessionId, ${JSON.stringify(terminalCommand + '\r')})
    return true
  })()`)
  assert(outputCaptureReady, 'Active terminal session was not ready')
  let terminalAfter = null
  for (let attempt = 0; attempt < 30; attempt++) {
    terminalAfter = await evaluate(`(() => {
      const terminal = document.querySelector('[data-terminal-instance]:not(.invisible)')
      const accessibilityText = terminal?.querySelector('.xterm-accessibility-tree')?.textContent ?? ''
      const rowText = Array.from(terminal?.querySelectorAll('.xterm-rows span') ?? []).map((node) => node.textContent).join(' ')
      const ptyText = window.__electronRestoredTerminalOutput ?? ''
      const text = ptyText + ' ' + accessibilityText + ' ' + rowText
      return {
        found: ptyText.includes(${JSON.stringify(terminalMarker)}),
        exits: (document.body?.textContent?.match(/Process exited with code/g) ?? []).length,
        text: text.slice(-1200),
      }
    })()`)
    if (terminalAfter.found) break
    await wait(200)
  }
  assert(terminalAfter?.found, `Terminal command output missing: ${JSON.stringify(terminalAfter)}`)
  assert(terminalAfter.exits === 0, 'Terminal exited after command')
  const terminalShot = await screenshot('electron-restored-terminal.png')
  await evaluate(`(() => {
    window.__electronRestoredRemoveTerminalData?.()
    delete window.__electronRestoredRemoveTerminalData
    delete window.__electronRestoredTerminalOutput
  })()`)

  await evaluate(`document.querySelector('[role="tab"][aria-label^="Conversation:"]')?.click()`)
  await wait(300)
  assert(await evaluate(`Boolean(document.querySelector('[data-editor-group="chat"] [data-chat-composer]')?.offsetParent)`), 'Chat tab did not restore')
  assert(await evaluate(`document.querySelectorAll('[data-terminal-instance]').length === 3`), 'Terminal sessions unmounted behind Chat')
  await evaluate(`document.querySelector('[data-terminal-tab="' + ${JSON.stringify(terminalBefore.activeTabId)} + '"]')?.click()`)
  await wait(300)
  const terminalRestored = await evaluate(`(() => {
    const terminal = document.querySelector('[data-terminal-instance]:not(.invisible)')
    return {
      sessionId: terminal?.getAttribute('data-terminal-session-id') ?? null,
      instances: document.querySelectorAll('[data-terminal-instance]').length,
    }
  })()`)
  assert(terminalRestored.instances === 3 && terminalRestored.sessionId === terminalBefore.sessionId, `Terminal session restarted after tab switch: ${JSON.stringify({ terminalBefore, terminalRestored })}`)
  await evaluate(`document.querySelector('[role="tab"][aria-label^="Conversation:"]')?.click()`)
  await wait(200)

  const skillsOpened = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent?.trim() === 'Skills')
    button?.click()
    return Boolean(button)
  })()`)
  assert(skillsOpened, 'Skills navigation missing')
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await evaluate(`(document.body?.innerText ?? '').includes('Skills Library')`)) break
    await wait(250)
  }
  assert(await evaluate(`(document.body?.innerText ?? '').includes('Skills Library')`), 'Skills view failed')
  const skillsShot = await screenshot('electron-restored-skills.png')

  await evaluate(`document.querySelector('[data-sidebar="footer"] button')?.click()`)
  await wait(300)
  const scaleStates = []
  for (const scale of ['0.85', '1.37', '2']) {
    await evaluate(`document.body.style.setProperty('--font-scale', ${JSON.stringify(scale)})`)
    await wait(150)
    const state = await evaluate(`(() => {
      const body = document.body
      const bodyRect = body.getBoundingClientRect()
      const dialog = document.querySelector('[data-slot="dialog-content"]')
      const dialogRect = dialog?.getBoundingClientRect()
      const titleRect = dialog?.querySelector('[data-slot="dialog-title"]')?.getBoundingClientRect()
      return {
        cssScale: getComputedStyle(body).getPropertyValue('--font-scale').trim(),
        transform: getComputedStyle(body).transform,
        visualWidth: bodyRect.width,
        visualHeight: bodyRect.height,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        dialogOpen: Boolean(dialog),
        dialogTop: dialogRect?.top ?? -1,
        dialogBottom: dialogRect?.bottom ?? -1,
        dialogWidth: dialogRect?.width ?? 0,
        titleTop: titleRect?.top ?? -1,
        titleHeight: titleRect?.height ?? 0,
      }
    })()`)
    assert(state.cssScale === scale && state.transform !== 'none', `Body scale missing at ${scale}`)
    assert(Math.abs(state.visualWidth - state.viewportWidth) < 2, `Scaled body width mismatch at ${scale}`)
    assert(Math.abs(state.visualHeight - state.viewportHeight) < 2, `Scaled body height mismatch at ${scale}`)
    assert(state.dialogOpen && state.dialogTop >= 0 && state.dialogBottom <= state.viewportHeight && state.titleTop >= 0 && state.titleHeight > 0, `Portal dialog clipped at ${scale}: ${JSON.stringify(state)}`)
    scaleStates.push(state)
  }
  const scaleState = scaleStates.find((state) => state.cssScale === '1.37')
  await evaluate(`document.body.style.setProperty('--font-scale', '1.37')`)
  const scaleShot = await screenshot('electron-restored-scale-137.png')
  await evaluate(`document.querySelector('[data-slot="dialog-close-button"]')?.click()`)
  await evaluate(`document.body.style.setProperty('--font-scale', '2')`)

  const assertDialogVisible = async (title) => {
    await wait(200)
    const state = await evaluate(`(() => {
      const dialog = document.querySelector('[data-slot="dialog-content"]')
      const rect = dialog?.getBoundingClientRect()
      return {
        title: dialog?.querySelector('[data-slot="dialog-title"]')?.textContent?.trim() ?? null,
        top: rect?.top ?? -1,
        bottom: rect?.bottom ?? -1,
        left: rect?.left ?? -1,
        right: rect?.right ?? -1,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
      }
    })()`)
    assert(state.title === title && state.top >= 0 && state.bottom <= state.viewportHeight && state.left >= 0 && state.right <= state.viewportWidth, `${title} clipped at 2x: ${JSON.stringify(state)}`)
    return state
  }

  const agentMenuOpened = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('[data-sidebar="menu-button"]'))
      .find((item) => item.textContent?.includes('Electron Smoke Agent'))
    const row = button?.closest('[data-sidebar="menu-item"]')
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return Boolean(row)
  })()`)
  assert(agentMenuOpened, 'Agent fixture row missing')
  let agentSettingsOpened = false
  for (let attempt = 0; attempt < 20; attempt++) {
    agentSettingsOpened = await evaluate(`(() => {
      const item = Array.from(document.querySelectorAll('[role="menuitem"]'))
        .find((node) => node.textContent?.trim() === 'Settings')
      item?.click()
      return Boolean(item)
    })()`)
    if (agentSettingsOpened) break
    await wait(100)
  }
  assert(agentSettingsOpened, 'Agent Settings menu item missing')
  await assertDialogVisible('Agent profile')
  await evaluate(`document.querySelector('[data-slot="dialog-close-button"]')?.click()`)

  await evaluate(`document.body.style.setProperty('--font-scale', '1')`)
  await evaluate(`document.querySelector('button[aria-label="Add agent"]')?.click()`)
  const createAgentNominalWidth = await evaluate(`document.querySelector('[data-slot="dialog-content"]')?.getBoundingClientRect().width ?? 0`)
  assert(createAgentNominalWidth > 0 && createAgentNominalWidth <= 577, `Create Agent max-w-xl overridden: ${createAgentNominalWidth}`)
  await evaluate(`document.querySelector('[data-slot="dialog-close-button"]')?.click()`)
  await evaluate(`document.body.style.setProperty('--font-scale', '2')`)
  await evaluate(`document.querySelector('button[aria-label="Add agent"]')?.click()`)
  await assertDialogVisible('Create Agent')
  await evaluate(`document.querySelector('[data-slot="dialog-close-button"]')?.click()`)

  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 2 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, nativeVirtualKeyCode: 75, modifiers: 2 })
  let searchReady = false
  for (let attempt = 0; attempt < 20; attempt++) {
    searchReady = await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Search BrightCode"]')
      if (!input) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'Scale Search Fixture')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    if (searchReady) break
    await wait(100)
  }
  assert(searchReady, 'Search dialog missing')
  await wait(250)
  const searchScale = await evaluate(`(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]')
    const scroller = dialog?.querySelector('.overflow-y-auto')
    const results = Array.from(scroller?.querySelectorAll('button') ?? [])
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    const rect = dialog?.getBoundingClientRect()
    const lastRect = results.at(-1)?.getBoundingClientRect()
    return {
      resultCount: results.length,
      top: rect?.top ?? -1,
      bottom: rect?.bottom ?? -1,
      left: rect?.left ?? -1,
      right: rect?.right ?? -1,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      lastTop: lastRect?.top ?? -1,
      lastBottom: lastRect?.bottom ?? -1,
    }
  })()`)
  assert(searchScale.resultCount === 30 && searchScale.top >= 0 && searchScale.bottom <= searchScale.viewportHeight && searchScale.left >= 0 && searchScale.right <= searchScale.viewportWidth && searchScale.lastTop >= searchScale.top && searchScale.lastBottom <= searchScale.bottom, `Search clipped at 2x: ${JSON.stringify(searchScale)}`)
  await evaluate(`(() => {
    document.querySelector('[data-slot="dialog-close-button"]')?.click()
    document.body.style.setProperty('--font-scale', localStorage.getItem('brightcode:font-scale') || '1')
  })()`)

  assert(exceptions.length === 0, `Runtime exceptions: ${exceptions.join('\n')}`)
  console.log(JSON.stringify({ mode, pageUrl: page.url, newTaskState, baseState, filesState, filesVisible, terminalBefore, terminalAfter, scaleState, screenshots: [newTaskShot, terminalShot, skillsShot, scaleShot], exceptions }, null, 2))
  console.log('Electron restored smoke passed.')
} finally {
  try {
    await evaluate(`(async () => {
      const fixture = ${JSON.stringify(fixture)}
      for (const taskId of fixture?.searchTaskIds ?? []) await window.electronAPI.tasks.remove(taskId)
      if (fixture?.taskId) await window.electronAPI.tasks.remove(fixture.taskId)
      if (fixture?.agentId) await window.electronAPI.agents.remove(fixture.agentId)
      if (fixture?.originalProjectId) await window.electronAPI.projects.setActive(fixture.originalProjectId)
      if (fixture?.projectCreated && fixture.projectId) await window.electronAPI.projects.remove(fixture.projectId)
      return true
    })()`, true)
  } finally {
    socket.close()
  }
}
