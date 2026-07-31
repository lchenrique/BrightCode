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
