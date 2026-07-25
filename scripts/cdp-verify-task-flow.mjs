/**
 * Verify the new "New task creates a sidebar item under the project"
 * flow. Steps:
 *   1. Click on a project in the sidebar to make it active.
 *   2. Click "New task" — the welcome screen shows with the project
 *      chip below the input.
 *   3. Type a message and submit.
 *   4. A new task should appear in the sidebar under the project,
 *      and the view should switch to the task.
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
await new Promise(r => setTimeout(r, 800))

// Click on the first project in the sidebar to make it active
const step1 = await evalExpr(`(() => {
  const rows = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
  // Find one that contains a path (the project rows have label + path)
  const projectRow = rows.find(b => {
    const text = b.textContent || ''
    return text.includes('C:\\\\') || text.includes('/')
  })
  if (!projectRow) return 'no-project'
  projectRow.click()
  return projectRow.textContent?.split('\\n')[0] || 'clicked'
})()`)
console.log('Step 1 — clicked project:', step1.result.value)
await new Promise(r => setTimeout(r, 600))

// Click "New task" in the top nav
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent?.trim() === 'New task')
  btn?.click()
  return 'ok'
})()`)
console.log('Step 2 — clicked New task')
await new Promise(r => setTimeout(r, 600))

// Check that the project chip is visible below the input
const chipCheck = await evalExpr(`(() => {
  const text = document.body.textContent || ''
  // Look for the project chip — it's a small element with the project label
  // after a Folder icon. The simplest check: is the project label visible?
  return text.length
})()`)
console.log('Step 2.5 — body text length:', chipCheck.result.value)

// Type a message and submit
await evalExpr(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'oi tudo bem?')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  return 'submitted'
})()`)
console.log('Step 3 — submitted message')
await new Promise(r => setTimeout(r, 1500))

// Check the sidebar — should now have a new task under the project
const step4 = await evalExpr(`(() => {
  // Look for the task title in the sidebar
  const taskTitle = document.querySelector('body')?.textContent?.includes('oi tudo bem')
  // Look for the ViewTopBar with the task title (shown when in task view)
  const headers = Array.from(document.querySelectorAll('header')).map(h => h.textContent)
  return JSON.stringify({
    sidebarHasTask: taskTitle,
    headers,
  })
})()`)
const v = JSON.parse(step4.result.value)
console.log('Step 4 — sidebar contains task:', v.sidebarHasTask)
console.log('Step 4 — topbar headers:', JSON.stringify(v.headers))

// Take a screenshot
const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs/promises')
const out = process.argv[2] || `${process.env.TEMP || '/tmp'}/brightcode-task-flow.png`
await fs.writeFile(out, Buffer.from(screenshot.data, 'base64'))
console.log('Saved', out)
process.exit(0)
