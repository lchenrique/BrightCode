/**
 * Verify list_files handles a project that was just set up correctly.
 *
 *   1. Create a fresh project, set it active, write 2 files (one in a
 *      subdir).
 *   2. Call list_files({recursive: true}) — should return src + README + index.
 *   3. Verify summary counter "1 dir · 2 files".
 *   4. Cleanup.
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) { console.error('No page target at', HOST); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await send('Runtime.enable', {})
await sleep(800)

const testName = 'bc-listfiles-test'
const setup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const old = list.find(p => p.label === '${testName}')
  if (old) await window.electronAPI.projects.remove(old.id)
  const dir = await window.electronAPI.fs.defaultProjectsDir()
  const target = dir + '/${testName}'
  await window.electronAPI.fs.createDir(target + '/src')
  // Add + setActive FIRST so write_file / list_files have a project root.
  const r = await window.electronAPI.projects.add(target, '${testName}')
  await window.electronAPI.projects.setActive(r.project.id)
  await new Promise(res => setTimeout(res, 300))
  const w1 = await window.electronAPI.tools.execute('write_file', { path: 'README.md', content: '# test\\n' })
  const w2 = await window.electronAPI.tools.execute('write_file', { path: 'src/index.ts', content: 'export const x = 1\\n' })
  return JSON.stringify({ target, add: r, w1, w2 })
})()`)
console.log('Setup →', setup.result.value)

const list = await evalExpr(`(async () => {
  const r = await window.electronAPI.tools.execute('list_files', { recursive: true })
  return JSON.stringify(r, null, 2)
})()`)
console.log('\n=== list_files recursive ===')
console.log(list.result.value)

const parsed = JSON.parse(list.result.value)
const dirs = parsed.result.filter((e) => e.isDir).length
const files = parsed.result.filter((e) => !e.isDir).length
console.log(`\nCounted: ${dirs} dir · ${files} file${files === 1 ? '' : 's'}`)

if (dirs !== 1 || files !== 2) {
  console.error(`FAIL: expected 1 dir · 2 files, got ${dirs} dir · ${files} files`)
  process.exit(1)
}

// Cleanup
const cleanup = await evalExpr(`(async () => {
  const list = await window.electronAPI.projects.list()
  const t = list.find(p => p.label === '${testName}')
  if (t) await window.electronAPI.projects.remove(t.id)
  return 'cleaned'
})()`)
console.log('\nCleanup →', cleanup.result.value)
process.exit(0)
