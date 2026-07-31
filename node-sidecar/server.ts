/**
 * BrightCode Node sidecar entrypoint.
 *
 * Listens on a random localhost port, enforces a per-process bearer
 * token on every request, and prints a single JSON line to stdout
 * once it's ready so the Rust supervisor can read `port` + `auth`.
 *
 * Contract (consumed by src-tauri/src/sidecar.rs):
 *   stdout line 1: {"auth":"<64-hex>","port":<int>}
 *   any later stdout is free-form logs.
 */

import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import { registerIpcRoutes } from './ipc.js'

const authToken = randomBytes(32).toString('hex')

// Logger off so stdout is reserved for the ready contract (Task 2.3
// supervisor parses line 1). Use stderr (process.stderr.write /
// pino) for ad-hoc diagnostics while debugging.
const app = Fastify({
  logger: false,
})

// Reject anything without the matching bearer token. Rust proxy is the
// only legit caller; if a request reaches us without the token, the
// process is either misconfigured or being probed.
app.addHook('preHandler', async (request, reply) => {
  const header = request.headers.authorization
  if (header !== `Bearer ${authToken}`) {
    reply.code(401).send({ error: 'unauthorized' })
  }
})

await registerIpcRoutes(app)

// 127.0.0.1 only — never expose to LAN. Port 0 = OS-assigned.
await app.listen({ host: '127.0.0.1', port: 0 })

const address = app.server.address()
if (!address || typeof address === 'string') {
  console.error('[sidecar] failed to bind: no address returned')
  process.exit(1)
}

process.stdout.write(`${JSON.stringify({ auth: authToken, port: address.port })}\n`)

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  process.stderr.write(`[sidecar] received ${signal}, shutting down\n`)
  await app.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
