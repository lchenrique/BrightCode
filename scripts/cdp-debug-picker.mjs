/** Debug: step by step, what does the picker actually render? */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const HOST = 'http://localhost:9222'
const targets = await (await fetch(`${HOST}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5180'))
if (!page) { console.error('No main page'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
await new Promise((res) => ws.addEventListener('open', res))
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result || msg.error); pending.delete(msg.id) }
})
const send = (m, p) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise(r => pending.set(i, r)) }
const evalExpr = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable', {})
await send('Runtime.enable', {})

const outDir = join(process.cwd(), 'scripts', 'screenshots')
mkdirSync(outDir, { recursive: true })
async function snap(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, name), Buffer.from(r.data, 'base64'))
  console.log('→ snap:', name)
}

// 1) Go to WelcomeScreen
await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  btn?.click()
})()`)
await sleep(1500)
await snap('debug-01-welcome.png')

// 2) Check React internals — what does the WelcomeScreen compute?
const internal = await evalExpr(`(function() {
  const reg = window.__brightcodeRegistry
  const raw = reg.listAvailableModelsGrouped()
  // Simulate what WelcomeScreen does with groups
  const modelGroups = raw.map((g) => ({
    providerId: g.provider.id,
    providerName: g.provider.name,
    hasCredential: g.hasCredential,
    models: g.models,
  }))
  // Simulate what ModelSelector does with the groups
  function providerStatus(g) {
    if (g.hasCredential) return 'connected'
    return g.models.some((m) => m.free || m.requiresAuth === false) ? 'free' : 'unconfigured'
  }
  const sortedGroups = modelGroups
    .filter((g) => g.models.length > 0 && providerStatus(g) !== 'unconfigured')
  const hasAny = sortedGroups.length > 0
  return {
    rawGroupCount: raw.length,
    rawGroupNames: raw.map((g) => g.provider.name),
    modelGroupCount: modelGroups.length,
    sortedGroupCount: sortedGroups.length,
    sortedNames: sortedGroups.map((g) => g.providerName + ' (' + g.models.length + ' models, ' + providerStatus(g) + ')'),
    hasAny,
    version: reg.getVersion(),
    localStorage: window.localStorage.getItem('brightcode:last-selected-model'),
  }
})()`)
console.log('INTERNAL →', JSON.stringify(internal.result?.value, null, 1))

// 3) Now open the picker
await evalExpr(`document.querySelector('button[aria-label="Select model"]')?.click()`)
await sleep(800)
await snap('debug-02-picker-open.png')

// 4) Read what step we're on + items
const state = await evalExpr(`(() => {
  const wrapper = document.querySelector('[data-radix-popper-content-wrapper]')
  if (!wrapper) return { open: false }
  const content = wrapper.querySelector('> div')
  if (!content) return { open: true, noContent: true }
  // Check if we see a back button (model step) or provider items
  const backBtn = content.querySelector('button[aria-label="Back to providers"]')
  const hasBackBtn = !!backBtn
  const items = Array.from(content.querySelectorAll('[data-picker-item]'))
  const allButtons = Array.from(content.querySelectorAll('button')).map(b => ({
    text: (b.textContent || '').trim().slice(0, 50),
    'aria-label': b.getAttribute('aria-label') || '',
    'data-picker-item': b.hasAttribute('data-picker-item'),
  }))
  const spans = Array.from(content.querySelectorAll('span')).map(s => ({
    text: (s.textContent || '').trim().slice(0, 40),
    class: s.className.slice(0, 40),
  })).filter(s => s.text.length > 0)
  return {
    open: true,
    hasBackBtn,
    step: hasBackBtn ? 'model' : 'provider',
    itemCount: items.length,
    itemTexts: items.map(i => (i.textContent || '').trim().slice(0, 60)),
    allButtonsCount: allButtons.length,
    spans,
  }
})()`)
console.log('PICKER STATE →', JSON.stringify(state.result?.value, null, 1))

// 5) If we're in model step, go back to providers
if (state.result?.value?.hasBackBtn) {
  await evalExpr(`document.querySelector('button[aria-label="Back to providers"]')?.click()`)
  await sleep(600)
  await snap('debug-03-back-to-providers.png')
  const provState = await evalExpr(`(() => {
    const items = Array.from(document.querySelectorAll('[data-picker-item]'))
    return {
      itemCount: items.length,
      itemTexts: items.map(i => (i.textContent || '').trim().slice(0, 60)),
    }
  })()`)
  console.log('PROVIDER STEP →', JSON.stringify(provState.result?.value, null, 1))
}

// 6) If provider step shows only 1, read the button that triggered the popover
const triggerCheck = await evalExpr(`(() => {
  const trigger = document.querySelector('button[aria-label="Select model"]')
  if (!trigger) return { found: false }
  return {
    found: true,
    text: (trigger.textContent || '').trim(),
    disabled: trigger.hasAttribute('disabled'),
  }
})()`)
console.log('TRIGGER →', JSON.stringify(triggerCheck.result?.value, null, 1))

console.log('DONE')
process.exit(0)
