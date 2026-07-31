/**
 * Smoke test for the Phase 2 sidecar pipeline.
 *
 * Spawns the real `node-sidecar/bin/server.js`, parses the
 * `{auth,port}` ready line from stdout, POSTs to
 * `/v1/agent-runtime/thread/create`, and asserts the response
 * matches the `ThreadState` shape the renderer expects.
 *
 * Skips the Tauri shell entirely — this is a CDP-less smoke that
 * runs under plain `npm test`. Manual end-to-end through Tauri is
 * covered by `scripts/cdp-tauri-smoke.mjs` in Task 2.7.
 *
 * ponytail: spawning the real server is cheap and is the only
 * test that catches auth contract drift. Mocks would hide that.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const serverEntry = resolve(repoRoot, 'node-sidecar/bin/server.js')

/** Spawn the sidecar and resolve once the `{auth,port}` contract is on stdout. */
async function spawnSidecar() {
  const child = spawn(process.execPath, [serverEntry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const ready = new Promise((resolveReady, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx === -1) return
      const line = buffer.slice(0, newlineIdx).trim()
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        reject(new Error(`sidecar stdout not JSON: ${line}`))
        return
      }
      if (
        typeof parsed?.auth === 'string' &&
        typeof parsed?.port === 'number'
      ) {
        child.stdout.off('data', onData)
        resolveReady(parsed)
      }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => {
      reject(new Error(`sidecar exited (code=${code}) before sending ready`))
    })
  })

  const stop = async () => {
    if (child.exitCode != null) return
    child.kill('SIGTERM')
    await new Promise((r) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        r()
      }, 1000)
      child.on('exit', () => {
        clearTimeout(t)
        r()
      })
    })
  }

  return { child, ready, stop }
}

async function post(contract, path, body) {
  return fetch(`http://127.0.0.1:${contract.port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${contract.auth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

async function* readSse(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block
          .split('\n')
          .find((line) => line.startsWith('data:'))
          ?.slice(5)
          .trim()
        if (data) yield JSON.parse(data)
      }
    }
  } finally {
    await reader.cancel()
  }
}

describe('tauri-sidecar round-trip', () => {
  it('POST /v1/agent-runtime/thread/create returns ThreadState', async () => {
    const { ready, stop } = await spawnSidecar()
    try {
      const contract = await ready
      const res = await fetch(
        `http://127.0.0.1:${contract.port}/v1/agent-runtime/thread/create`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${contract.auth}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ threadId: 'smoke-test-1' }),
        },
      )
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.threadId).toBe('smoke-test-1')
      // Real ThreadState shape (mirrors electron/shared/agent-protocol.ts).
      // Criterion-3 lists (id, createdAt, updatedAt, events:[]) which
      // doesn't exist on the real interface — we use the actual fields.
      expect(typeof json.thread.threadId).toBe('string')
      expect(json.thread.generation).toBe(0)
      expect(json.thread.sequence).toBe(0)
      expect(json.thread.idle).toBe(true)
      expect(json.thread.turns).toEqual({})
      expect(json.thread.items).toEqual({})
    } finally {
      await stop()
    }
  }, 15_000)

  it('persists turn events and streams them through SSE', async () => {
    const { ready, stop } = await spawnSidecar()
    let events
    try {
      const contract = await ready
      const threadId = 'runtime-flow'
      expect((await post(contract, '/v1/agent-runtime/thread/create', { threadId })).status).toBe(200)

      const eventResponse = await fetch(
        `http://127.0.0.1:${contract.port}/v1/agent-runtime/events/stream?subscriptionId=test-sub&threadId=${threadId}`,
        { headers: { authorization: `Bearer ${contract.auth}` } },
      )
      expect(eventResponse.status).toBe(200)
      events = readSse(eventResponse)

      const start = await post(contract, '/v1/agent-runtime/turn/start', {
        threadId,
        prompt: 'hello',
      })
      expect(start.status).toBe(200)
      const { turnId } = await start.json()

      const started = await events.next()
      expect(started.value.event.type).toBe('turn-start')
      expect(started.value.event.turnId).toBe(turnId)
      expect(started.value.state.itemOrder).toHaveLength(1)

      const history = await post(contract, '/v1/agent-runtime/history/read', {
        threadId,
        afterSequence: -1,
      })
      expect(history.status).toBe(200)
      expect((await history.json()).map((event) => event.type)).toContain('turn-start')

      const interrupted = await post(contract, '/v1/agent-runtime/turn/interrupt', { threadId })
      expect(interrupted.status).toBe(200)
      expect((await events.next()).value.event.type).toBe('turn-interrupted')
    } finally {
      await events?.return()
      await stop()
    }
  }, 15_000)

  it('rejects requests without bearer token', async () => {
    const { ready, stop } = await spawnSidecar()
    try {
      const contract = await ready
      const res = await fetch(
        `http://127.0.0.1:${contract.port}/v1/agent-runtime/thread/create`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      expect(res.status).toBe(401)
    } finally {
      await stop()
    }
  }, 15_000)

  it('rejects schema-invalid body with 400', async () => {
    const { ready, stop } = await spawnSidecar()
    try {
      const contract = await ready
      // `threadId: ""` violates minLength: 1 in node-sidecar/ipc.ts
      // schema. Fastify's validator should return 400 before the
      // handler runs.
      const res = await fetch(
        `http://127.0.0.1:${contract.port}/v1/agent-runtime/thread/create`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${contract.auth}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ threadId: '' }),
        },
      )
      expect(res.status).toBe(400)
    } finally {
      await stop()
    }
  }, 15_000)
})
