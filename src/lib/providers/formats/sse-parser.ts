/**
 * Minimal SSE (Server-Sent Events) parser for streaming chat completions.
 *
 * Handles both `data: ...` (OpenAI-style) and `event: name\ndata: ...`
 * (Anthropic-style) event shapes. Designed to be fed by a `ReadableStream<Uint8Array>`
 * coming out of `fetch().body`.
 *
 * Not a full EventSource implementation — no auto-retry, no Last-Event-ID,
 * no readystate. Those don't apply to one-shot chat streams.
 */

export interface SSEEvent {
  event?: string
  data: string
  id?: string
}

/**
 * Parse a ReadableStream<Uint8Array> into SSE events.
 *
 * SSE wire format reminder:
 *   event: message_start            ← optional event name
 *   data: {"foo": "bar"}            ← required data
 *   id: 42                          ← optional event id
 *
 *   \n                              ← blank line marks event boundary
 *
 * Lines are split on `\n`; events on `\n\n`. A line starting with `:` is
 * a comment and skipped. Trailing `\r` is stripped.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()

  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel()
        throw new DOMException('Stream aborted', 'AbortError')
      }

      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete events (split on \n\n)
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (raw) {
          const event = parseSSERecord(raw)
          if (event) yield event
        }
      }
    }

    // Flush any trailing record (no final newline)
    if (buffer.trim()) {
      const event = parseSSERecord(buffer)
      if (event) yield event
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

function parseSSERecord(raw: string): SSEEvent | null {
  const lines = raw.split('\n')
  const event: SSEEvent = { data: '' }
  let hasData = false

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue // empty line / comment

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const field = line.slice(0, colonIdx)
    let value = line.slice(colonIdx + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        event.event = value
        break
      case 'data':
        event.data += (hasData ? '\n' : '') + value
        hasData = true
        break
      case 'id':
        event.id = value
        break
      // ignore retry, etc.
    }
  }

  return hasData ? event : null
}
