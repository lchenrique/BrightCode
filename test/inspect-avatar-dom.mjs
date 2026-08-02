import { setTimeout as wait } from 'node:timers/promises'
const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const t = targets.find((x) => x.type === 'page')
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res) => ws.addEventListener('open', res, { once: true }))
let id = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data.toString())
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const cmdId = ++id
    pending.set(cmdId, { resolve, reject })
    ws.send(JSON.stringify({ id: cmdId, method, params }))
  })
await send('Runtime.enable')
await wait(800)
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const team = [...document.querySelectorAll('*')].filter(e => e.childElementCount === 0 && e.textContent.trim() === 'AGENT TEAM')
    const section = team[0]?.closest('div[data-slot]') ?? team[0]?.parentElement?.parentElement
    const sectionHtml = section ? section.innerHTML.slice(0, 1200) : 'NO SECTION'
    const imgs = document.querySelectorAll('img').length
    const svgs = document.querySelectorAll('svg').length
    const agentAvatarSpans = [...document.querySelectorAll('span')].filter(s => (s.className?.toString() || '').includes('ring-border'))
    return {
      teamFound: team.length,
      imgs, svgs,
      agentAvatarSpans: agentAvatarSpans.length,
      spanSample: agentAvatarSpans.slice(0, 2).map(s => s.className.toString()),
      sectionHtml,
    }
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 2))
ws.close()
process.exit(0)
