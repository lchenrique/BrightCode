/**
 * Screenshot the AddProjectDialog for visual review.
 * Run after `npm run electron:dev` is up.
 */

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'))
if (!page) {
  console.error('No renderer page found')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result || msg.error)
    pending.delete(msg.id)
  }
})
const send = (method, params) => {
  const mid = ++id
  ws.send(JSON.stringify({ id: mid, method, params }))
  return new Promise((res) => pending.set(mid, res))
}

await send('Runtime.enable', {})
await new Promise((r) => setTimeout(r, 800))

// Open the dialog
await send('Runtime.evaluate', {
  expression: `document.querySelector('button[aria-label="Add project"]')?.click(); 'ok'`,
  returnByValue: true,
})
await new Promise((r) => setTimeout(r, 400))

// Click "Create new project" so the form panel is visible
await send('Runtime.evaluate', {
  expression: `(() => {
    const btns = Array.from(document.querySelectorAll('[data-slot="dialog-content"] button'))
    const target = btns.find(b => b.textContent?.includes('Create new project'))
    target?.click()
    return 'ok'
  })()`,
  returnByValue: true,
})
await new Promise((r) => setTimeout(r, 250))

const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs/promises')
const out = process.argv[2] || `${process.env.TEMP || '/tmp'}/brightcode-add-project.png`
await fs.writeFile(out, Buffer.from(screenshot.data, 'base64'))
console.log('Saved', out)

process.exit(0)
