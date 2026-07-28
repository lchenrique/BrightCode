/** Probe deeper: what does the picker actually receive as modelGroups? */
import { writeFileSync } from 'node:fs'

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

await send('Page.enable', {})
await send('Runtime.enable', {})

await evalExpr(`(() => {
  const btn = Array.from(document.querySelectorAll('button'))
    .find((b) => (b.textContent || '').trim() === 'New task')
  btn?.click()
})()`)
await new Promise((r) => setTimeout(r, 1500))

// Read the actual DOM state — find the ChatInput component's rendered groups
// by checking the popover content BEFORE opening
const groups = await evalExpr(`(function() {
  const reg = window.__brightcodeRegistry
  // Simulate what WelcomeScreen does
  const raw = reg.listAvailableModelsGrouped()
  const groups = raw.map((g) => ({
    providerId: g.provider.id,
    providerName: g.provider.name,
    hasCredential: g.hasCredential,
    modelCount: g.models.length,
  }))
  // Also check providerStatus for each
  function providerStatus(hasCred, models) {
    if (hasCred) return 'connected'
    return models.some((m) => m.free || m.requiresAuth === false) ? 'free' : 'unconfigured'
  }
  const statuses = raw.map((g) => ({
    id: g.provider.id,
    status: providerStatus(g.hasCredential, g.models),
    modelCount: g.models.length,
  }))
  return { groups, statuses }
})()`)
console.log('SIMULATED GROUPS →', JSON.stringify(groups.result?.value, null, 1))

// Now force-open picker and directly measure what renders
await evalExpr(`document.querySelector('button[aria-label="Select model"]')?.click()`)
await new Promise((r) => setTimeout(r, 800))

// Read visible data-picker-item buttons (provider step)
const step = await evalExpr(`(() => {
  const wrapper = document.querySelector('[data-radix-popper-content-wrapper]')
  if (!wrapper) return { ok: false }
  const headerText = Array.from(wrapper.querySelectorAll('span, div'))
    .filter((e) => e.textContent?.includes('Open') || e.textContent?.includes('MiniMax') || e.textContent?.includes('OpenAI'))
    .map((e) => e.textContent?.trim())
  const items = Array.from(wrapper.querySelectorAll('[data-picker-item]'))
    .map((i) => {
      const textSpans = Array.from(i.querySelectorAll('span'))
        .map((s) => s.textContent?.trim())
        .filter(Boolean)
      return { all: (i.textContent || '').trim().slice(0, 80), spans: textSpans }
    })
  const btns = Array.from(wrapper.querySelectorAll('button'))
    .map((b) => ({ text: (b.textContent || '').trim().slice(0, 60), 'data-picker-item': b.hasAttribute('data-picker-item') }))
  return { ok: true, headerText, items, buttons: btns }
})()`)
console.log('PICKER RENDER →', JSON.stringify(step.result?.value, null, 1))

process.exit(0)
