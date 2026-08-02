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
await wait(500)
const r = await send('Runtime.evaluate', {
  expression: `(() => {
    let agents = null
    try { agents = JSON.parse(localStorage.getItem('brightcode.agents.v1') || 'null') } catch {}
    const labels = [...document.querySelectorAll('[data-slot="sidebar-group-label"], [role="group"]')].map(e => e.textContent.trim())
    const agentTeam = [...document.querySelectorAll('div')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'AGENT TEAM')
    let parent = null
    if (agentTeam) {
      let p = agentTeam.parentElement
      parent = { tag: p?.tagName, slot: p?.getAttribute('data-slot'), cls: (p?.className||'').toString().slice(0, 120), html: p?.innerHTML.slice(0, 500) }
    }
    return { agents: agents ? Object.keys(agents).map(k => ({ id: agents[k].id, name: agents[k].name, enabled: agents[k].enabled })) : 'NO STORE', labels: labels.slice(0, 8), agentTeamParent: parent }
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(r.result.value, null, 2))
ws.close()
process.exit(0)
