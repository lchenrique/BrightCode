/**
 * E2E for the project view:
 *  1. Make sure a project exists
 *  2. Click it in the sidebar → ProjectView opens with split layout
 *  3. Verify scroll container exists with the correct overflow
 *  4. Submit a tool-calling question
 *  5. Wait for completion
 *  6. Capture the chat with the tool call + EditedFilesCard + ProgressPanel
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) { console.error('No page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0; const pending = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

await send('Runtime.enable', {})
await new Promise(r => setTimeout(r, 1500))

const testName = 'bc-projectview-test'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target)
  await window.electronAPI.tools.execute('write_file', { path: 'hello.md', content: '# Hi\\n\\nGreetings from project view test.\\n' })
  await window.electronAPI.projects.add(target, '${testName}')
  return 'ok'
})()`)
console.log('Setup:', setup.result.value)
await new Promise(r => setTimeout(r, 600))

// Click the project in the sidebar
const click = await evalExpr(`(() => {
  const btns = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
  const target = btns.find(b => b.textContent?.includes('${testName}'))
  if (!target) return 'NOT FOUND'
  target.click()
  return 'clicked'
})()`)
console.log('Click project:', click.result.value)
await new Promise(r => setTimeout(r, 800))

// Inspect the layout: should have ViewTopBar (with project label) + Progress panel + chat
const inspect = await evalExpr(`(() => {
  const topbar = document.querySelector('header')
  const progressAside = document.querySelector('aside')
  const main = document.querySelector('main')
  const scrollables = Array.from(document.querySelectorAll('main *')).filter(el => {
    const cs = getComputedStyle(el)
    return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
  }).map(el => ({
    tag: el.tagName,
    classes: el.className,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    minHeight: getComputedStyle(el).minHeight,
    overflow: getComputedStyle(el).overflowY,
  }))
  return JSON.stringify({
    topbarText: topbar?.textContent?.trim().slice(0, 80),
    progressTitle: progressAside?.querySelector('span')?.textContent,
    hasScrollables: scrollables.length,
    scrollables,
  }, null, 2)
})()`)
console.log('\n=== ProjectView layout ===')
console.log(inspect.result.value)

// Submit a question that triggers a tool call
const submit = await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'Use list_files with recursive: true to see all files in this project, then read the first .md file and tell me its content.')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'ok'
})()`)
console.log('\nSubmit:', submit.result.value)

for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const c = await evalExpr(`(() => {
    const sp = document.querySelector('.animate-pulse')
    const bubbles = Array.from(document.querySelectorAll('[class*="whitespace-pre-wrap"]'))
    const editedCard = Array.from(document.querySelectorAll('*')).find(el => el.textContent?.includes('Edited') && el.textContent?.includes('files'))
    return JSON.stringify({ hasSpinner: sp !== null, count: bubbles.length, hasEditedCard: !!editedCard })
  })()`)
  const v = JSON.parse(c.result.value)
  console.log(`[${i*2}s] bubbles=${v.count} hasSpinner=${v.hasSpinner} editedCard=${v.hasEditedCard}`)
  if (v.count > 0 && !v.hasSpinner && v.hasEditedCard) break
}

// Try scrolling
const scrollTest = await evalExpr(`(() => {
  const scrollables = Array.from(document.querySelectorAll('main *')).filter(el => {
    const cs = getComputedStyle(el)
    return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
  })
  if (scrollables.length === 0) return JSON.stringify({ ok: false, reason: 'no scrollable' })
  const el = scrollables[0]
  el.scrollTop = 0
  const top0 = el.scrollTop
  el.scrollTop = el.scrollHeight
  const top1 = el.scrollTop
  return JSON.stringify({ ok: true, atTop: top0, atBottom: top1, scrollable: el.scrollHeight > el.clientHeight })
})()`)
console.log('\n=== Scroll test ===')
console.log(scrollTest.result.value)

const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('Cleanup:', cleanup.result.value)
process.exit(0)
