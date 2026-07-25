/**
 * Smoke test for the Projects feature.
 *
 *   1. List current projects (via `window.electronAPI.projects.list()`)
 *   2. Click the "+" next to "Projects" → expect AddProjectDialog to open
 *   3. Click "Create new project" → expect the create panel to expand
 *   4. Type a name and click "Create and add"
 *   5. Expect the project to appear in the sidebar and become active
 *
 * Run: `node scripts/cdp-projects.mjs`
 * Requires `npm run electron:dev` to be up (and CDP port 9222 listening).
 */

const HOST = 'http://localhost:9222'

async function listTargets() {
  const r = await fetch(`${HOST}/json`)
  return r.json()
}

async function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('open', () => {
      const send = (method, params) => {
        const mid = ++id
        ws.send(JSON.stringify({ id: mid, method, params }))
        return new Promise((res) => pending.set(mid, res))
      }
      resolve({ ws, send })
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg.result || msg.error)
        pending.delete(msg.id)
      }
    })
  })
}

const targets = await listTargets()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) {
  console.error('No renderer page found')
  process.exit(1)
}
console.log('Connecting to:', page.url)

const { send } = await connect(page.webSocketDebuggerUrl)
await send('Runtime.enable', {})

await new Promise((r) => setTimeout(r, 1500))

const evalExpr = (expression) =>
  send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

// ── 1. Initial state ──────────────────────────────────────────────────

const initial = await evalExpr(`(async () => {
  const projects = await window.electronAPI.projects.list()
  const active = await window.electronAPI.projects.getActive()
  return JSON.stringify({ projects, active }, null, 2)
})()`)
console.log('\n=== Initial projects ===')
console.log(initial.result.value)

// ── 2. Click "+" in sidebar ───────────────────────────────────────────

const clickAdd = await evalExpr(`(() => {
  const btn = document.querySelector('button[aria-label="Add project"]')
  if (!btn) return 'NOT FOUND'
  btn.click()
  return 'clicked'
})()`)
console.log('\nClick "+" →', clickAdd.result.value)
await new Promise((r) => setTimeout(r, 500))

// ── 3. Verify dialog open + click "Create new project" ────────────────

const dialogState = await evalExpr(`(() => {
  const titleEl = document.querySelector('[data-slot="dialog-content"]')
  if (!titleEl) return JSON.stringify({ open: false })
  const title = titleEl.querySelector('[data-slot="dialog-title"]')?.textContent
  const buttons = Array.from(titleEl.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(t => t)
  return JSON.stringify({ open: true, title, buttons })
})()`)
console.log('\nDialog state →', dialogState.result.value)

// Click "Create new project"
const clickCreate = await evalExpr(`(() => {
  const btns = Array.from(document.querySelectorAll('[data-slot="dialog-content"] button'))
  const target = btns.find(b => b.textContent?.includes('Create new project'))
  if (!target) return 'NOT FOUND'
  target.click()
  return 'clicked'
})()`)
console.log('\nClick "Create new project" →', clickCreate.result.value)
await new Promise((r) => setTimeout(r, 300))

// ── 4. Type a name and click "Create and add" ─────────────────────────

const testName = 'bc-cdp-test-' + Date.now().toString(36)

const fillAndSubmit = await evalExpr(`(async () => {
  const dialog = document.querySelector('[data-slot="dialog-content"]')
  if (!dialog) return 'no dialog'
  const input = dialog.querySelector('input[placeholder*="Project name"]')
  if (!input) return 'no input'
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, '${testName}')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 50))
  const btns = Array.from(dialog.querySelectorAll('button'))
  const submit = btns.find(b => b.textContent?.trim() === 'Create and add')
  if (!submit) return 'no submit'
  submit.click()
  return 'submitted'
})()`)
console.log('\nSubmit "Create and add" →', fillAndSubmit.result.value)
await new Promise((r) => setTimeout(r, 1500))

// ── 5. Verify project was added ──────────────────────────────────────

const after = await evalExpr(`(async () => {
  const projects = await window.electronAPI.projects.list()
  const active = await window.electronAPI.projects.getActive()
  return JSON.stringify({ projects, active }, null, 2)
})()`)
console.log('\n=== Projects after add ===')
console.log(after.result.value)

// Sidebar state
const sidebar = await evalExpr(`(() => {
  const items = Array.from(document.querySelectorAll('[data-slot="sidebar-menu-button"]'))
    .filter(b => b.textContent?.includes('${testName}') || b.textContent?.includes('BrightCodeProjects'))
  return JSON.stringify(items.map(b => b.textContent?.trim().slice(0, 80)))
})()`)
console.log('\nSidebar items matching new project →', sidebar.result.value)

// ── 6. Clean up: remove the test project ─────────────────────────────

const cleanup = await evalExpr(`(async () => {
  const projects = await window.electronAPI.projects.list()
  const target = projects.find(p => p.label === '${testName}')
  if (!target) return 'not found'
  const r = await window.electronAPI.projects.remove(target.id)
  return JSON.stringify(r)
})()`)
console.log('\nCleanup →', cleanup.result.value)

process.exit(0)
