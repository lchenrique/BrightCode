/**
 * Smoke test for the agent tools IPC.
 *
 *   1. Create a test project, drop a couple of files into it.
 *   2. Call `list_files` (with recursive) — expect both files + 1 subdir
 *   3. Call `read_file` on one of them — expect the original content
 *   4. Call `write_file` for a new file — expect { ok: true, bytes: N }
 *   5. Call `edit_file` to replace a string — expect replacements: 1
 *   6. Try to escape the sandbox (`../foo`) — expect ok: false
 *   7. Cleanup
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

const testName = 'bc-tools-test'
const setup = await evalExpr(`(async () => {
  // Cleanup old test if any
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target + '/src')
  // Drop a file
  await window.electronAPI.tools.execute('write_file', { path: 'README.md', content: '# Hello\\n\\nThis is a test project.\\n' })
  await window.electronAPI.tools.execute('write_file', { path: 'src/index.ts', content: 'export const answer = 42\\n' })
  const r = await window.electronAPI.projects.add(target, '${testName}')
  return JSON.stringify({ target, add: r })
})()`)
console.log('Setup →', setup.result.value)
await new Promise(r => setTimeout(r, 600))

// 1. list_files recursive
const list = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('list_files', { recursive: true })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== list_files recursive ===')
console.log(list.result.value)

// 2. read_file
const read = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('read_file', { path: 'README.md' })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== read_file README.md ===')
console.log(read.result.value)

// 3. write_file (new)
const write = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('write_file', { path: 'new.txt', content: 'fresh' })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== write_file new.txt ===')
console.log(write.result.value)

// 4. edit_file
const edit = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('edit_file', {
    path: 'README.md', oldText: 'This is a test project.', newText: 'This is a *real* test project.', replaceAll: false
  })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== edit_file README.md ===')
console.log(edit.result.value)

// 5. sandbox escape attempt
const escape = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('read_file', { path: '../package.json' })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== sandbox escape attempt ===')
console.log(escape.result.value)

// 6. search_files
const search = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('search_files', { query: 'answer' })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== search_files "answer" ===')
console.log(search.result.value)

// Cleanup
const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('\nCleanup →', cleanup.result.value)

process.exit(0)
