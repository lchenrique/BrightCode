/**
 * Smoke test for the BigPickle stream — mirrors what the Electron main
 * process does (Node fetch + SSE parse) to confirm the network chain
 * still works after refactors. Run with:
 *
 *   node scripts/smoke-stream.mjs
 */

const url = 'https://opencode.ai/zen/v1/chat/completions'
const body = JSON.stringify({
  model: 'big-pickle',
  messages: [{ role: 'user', content: 'ping' }],
  stream: true,
  max_tokens: 50,
})

const t0 = Date.now()
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body,
})

if (!response.ok) {
  console.error(`HTTP ${response.status}`)
  process.exit(1)
}
if (!response.body) {
  console.error('No body')
  process.exit(1)
}

const reader = response.body.getReader()
const decoder = new TextDecoder('utf-8')
let buf = ''
let chunks = 0
let firstText = ''

while (true) {
  const { value, done } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  let i
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, i)
    buf = buf.slice(i + 2)
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      chunks++
      try {
        const parsed = JSON.parse(data)
        const text = parsed?.choices?.[0]?.delta?.content
        if (text && !firstText) firstText = text
      } catch {
        // ignore non-JSON lines (e.g. ": OPENROUTER PROCESSING")
      }
    }
  }
}

const dt = Date.now() - t0
console.log(`OK ${dt}ms — ${chunks} data chunks`)
console.log(`first text: ${firstText.slice(0, 80)}`)
