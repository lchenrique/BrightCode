/**
 * Provider stream proxy — runs in the main process so the renderer never
 * has to deal with CORS, OS keyrings, or arbitrary network. The main
 * process fetches the upstream URL (built by the renderer's format
 * handler) and streams the raw SSE `data:` payloads back to the
 * renderer via `webContents.send`.
 *
 * The renderer is responsible for building the URL, headers, and body
 * (it knows the provider's wire format). The main process is just an
 * authenticated, no-CORS, async `fetch` with a streaming SSE parser.
 *
 * Each active request is identified by a `requestId` (generated on the
 * renderer side so the renderer can correlate chunks without a round
 * trip). Cancellation is signalled by `PROVIDER_STREAM_CANCEL`.
 */

import { ipcMain, type WebContents } from 'electron'
import { IPC } from '../shared/ipc-channels'

interface StartPayload {
  requestId: string
  providerId: string
  apiFormat: string
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

interface ActiveRequest {
  controller: AbortController
  providerId: string
}

const active = new Map<string, ActiveRequest>()

function send(contents: WebContents, event: string, requestId: string, payload: unknown): void {
  if (contents.isDestroyed()) return
  contents.send(event, requestId, payload)
}

async function processSSE(
  contents: WebContents,
  requestId: string,
  response: Response,
): Promise<void> {
  if (!response.body) {
    send(contents, `${IPC.PROVIDER_STREAM_ERROR}:${requestId}`, requestId, 'No response body')
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        if (!raw) continue
        for (const line of raw.split('\n')) {
          if (!line || line.startsWith(':')) continue
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            if (data === '[DONE]') continue
            send(contents, `${IPC.PROVIDER_STREAM_CHUNK}:${requestId}`, requestId, { raw: data })
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'CanceledError')) {
      return
    }
    send(
      contents,
      `${IPC.PROVIDER_STREAM_ERROR}:${requestId}`,
      requestId,
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

export function registerProviderProxy(): void {
  ipcMain.handle(
    IPC.PROVIDER_STREAM_START,
    async (event, payload: StartPayload): Promise<{ requestId: string }> => {
      const controller = new AbortController()
      active.set(payload.requestId, {
        controller,
        providerId: payload.providerId,
      })

      void (async () => {
        try {
          const response = await fetch(payload.url, {
            method: payload.method,
            headers: payload.headers,
            body: payload.body || undefined,
            signal: controller.signal,
          })
          if (!response.ok) {
            const text = await response.text().catch(() => '')
            send(
              event.sender,
              `${IPC.PROVIDER_STREAM_ERROR}:${payload.requestId}`,
              payload.requestId,
              `HTTP ${response.status}: ${text.slice(0, 500)}`,
            )
            return
          }
          await processSSE(event.sender, payload.requestId, response)
          send(event.sender, `${IPC.PROVIDER_STREAM_END}:${payload.requestId}`, payload.requestId, null)
        } catch (err) {
          if (
            err instanceof Error &&
            (err.name === 'AbortError' || err.name === 'CanceledError')
          ) {
            return
          }
          send(
            event.sender,
            `${IPC.PROVIDER_STREAM_ERROR}:${payload.requestId}`,
            payload.requestId,
            err instanceof Error ? err.message : String(err),
          )
        } finally {
          active.delete(payload.requestId)
        }
      })()

      return { requestId: payload.requestId }
    },
  )

  ipcMain.on(IPC.PROVIDER_STREAM_CANCEL, (_event, requestId: string) => {
    const req = active.get(requestId)
    if (req) {
      req.controller.abort()
      active.delete(requestId)
    }
  })
}
