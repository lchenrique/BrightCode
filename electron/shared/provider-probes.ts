/**
 * Provider probes — pure, electron-free.
 *
 * Mirrors `apps/desktop/electron/backend-probes.ts` from hermes-agent:
 * "cheap 'does this candidate actually work' checks" used by the connection
 * state machine. Probes are deliberately fast and forgiving:
 *
 *   - 5s timeout (a hung API beats forever, but we still give slow networks
 *     room to breathe)
 *   - Probes never throw — they return a `ProbeResult` (boolean OR classified
 *     failure), so the state machine can react without try/catch noise
 *   - The probe exercises the *real* auth + transport the app will use
 *     (Hermes rule: "An HTTP status probe passing while the WebSocket/auth
 *     leg fails is a false positive")
 *
 * Kept in a standalone module so it can be unit-tested with `node --test`
 * (or vitest) without dragging in the electron runtime. The main process
 * wires it to `fetch`; tests inject a stub.
 */

import {
  isAuthRejection,
  isConnectivityError,
  resolveProbeRequest,
  type AuthScheme,
  type ProbeRequest,
} from './provider-connection-config'
import type { ProviderCredential } from '../../src/lib/providers/types'

// ── Configuration ──────────────────────────────────────────────────────────

/** Default per-probe timeout. Mirrors `PROBE_TIMEOUT_MS` in hermes. */
export const PROBE_TIMEOUT_MS = 5_000

/**
 * Minimal `fetch`-compatible signature. Lets the test suite inject a stub
 * without standing up an HTTP server. Real code passes `globalThis.fetch`.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  },
) => Promise<{
  status: number
  statusText?: string
  ok: boolean
  text(): Promise<string>
  json(): Promise<unknown>
}>

// ── Result types ───────────────────────────────────────────────────────────

/** The state the UI can show next to each provider. */
export type ConnectionStatus =
  | 'untested'
  | 'probing'
  | 'connected'
  | 'auth-rejected'
  | 'unreachable'
  | 'server-error'
  | 'misconfigured'

export interface ProbeResult {
  status: ConnectionStatus
  /** Latency in ms (only set on success). */
  latencyMs?: number
  /** Last error message (set on any non-success state). */
  message?: string
  /** ISO timestamp of the probe. */
  testedAt: string
}

const OK_RESULT = (latencyMs: number): ProbeResult => ({
  status: 'connected',
  latencyMs,
  testedAt: new Date().toISOString(),
})

const FAIL = (
  status: Exclude<ConnectionStatus, 'connected' | 'untested' | 'probing'>,
  message: string,
): ProbeResult => ({
  status,
  message,
  testedAt: new Date().toISOString(),
})

// ── Probe entry point ──────────────────────────────────────────────────────

export interface ProbeSpec {
  baseUrl: string
  scheme: AuthScheme
  credential?: ProviderCredential
  override?: Parameters<typeof resolveProbeRequest>[0]['override']
  /** Override the probe timeout. Default `PROBE_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Inject a fetch implementation. Default `globalThis.fetch`. */
  fetch?: FetchLike
  /** Optional probe path override. Default `/models`. */
  probePath?: string
}

/**
 * Run a single probe. Never throws — failures are encoded in the result.
 *
 * Result mapping (Hermes-style):
 *   - HTTP 2xx                       → 'connected'
 *   - 401 / 403 / 407                → 'auth-rejected'
 *   - 5xx, malformed, network, …     → 'unreachable' (transient) or
 *                                       'server-error' (provider replied badly)
 *   - misconfigured (no token, bad URL) → 'misconfigured'
 */
export async function probeProvider(spec: ProbeSpec): Promise<ProbeResult> {
  const started = Date.now()

  // 1. Build the probe request from the spec.
  let req: ProbeRequest
  try {
    req = resolveProbeRequest({
      baseUrl: spec.baseUrl,
      scheme: spec.scheme,
      credential: spec.credential,
      probePath: spec.probePath,
      override: spec.override,
    })
  } catch (err) {
    return FAIL('misconfigured', err instanceof Error ? err.message : String(err))
  }

  // 2. Misconfigured: no credential at all. We still probe reachability so
  //    the user sees "the host is fine, but you need to sign in".
  if (!spec.credential) {
    const reachable = await probeReachableOnly(req, spec)
    if (reachable) {
      return FAIL('misconfigured', 'No credential configured for this provider.')
    }
    return reachable
  }

  // 3. Real probe: exercises auth + transport together.
  const fetcher = spec.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!fetcher) {
    return FAIL('misconfigured', 'No fetch implementation available in this runtime.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    const response = await fetcher(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started

    if (response.ok) {
      return OK_RESULT(latencyMs)
    }
    if (isAuthRejection({ status: response.status })) {
      return FAIL(
        'auth-rejected',
        `Provider rejected the credential (HTTP ${response.status} ${response.statusText ?? ''}). Re-authenticate and try again.`,
      )
    }
    if (response.status >= 500) {
      return FAIL(
        'server-error',
        `Provider returned HTTP ${response.status}. Try again in a moment.`,
      )
    }
    if (response.status === 404) {
      // Auth passed (no 401) but the probe path doesn't exist on this
      // provider — that's a "wrong path" mismatch, not a connection issue.
      // Treat as misconfigured so the user knows to fix the path.
      return FAIL(
        'misconfigured',
        `Provider responded but the probe path "${req.url}" was not found (HTTP 404). The provider may not be OpenAI-compatible.`,
      )
    }
    return FAIL(
      'server-error',
      `Provider returned HTTP ${response.status} ${response.statusText ?? ''}.`,
    )
  } catch (err) {
    return classifyFailure(err, req)
  } finally {
    clearTimeout(timer)
  }
}

// ── Reachability-only fallback (no credential) ─────────────────────────────

async function probeReachableOnly(
  req: ProbeRequest,
  spec: ProbeSpec,
): Promise<ProbeResult> {
  const fetcher = spec.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
  if (!fetcher) {
    return FAIL('misconfigured', 'No fetch implementation available in this runtime.')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? PROBE_TIMEOUT_MS)
  try {
    const response = await fetcher(req.url, {
      method: 'HEAD',
      signal: controller.signal,
    })
    // Any response (even 401/404) means the host is reachable.
    // The credential still wasn't sent (we only sent a HEAD with no auth
    // header), so we can't say "connected" — but we can say the host is
    // there. The caller already showed "no credential" as the primary
    // reason, so 'misconfigured' is honest.
    void response
    return FAIL('misconfigured', 'No credential configured for this provider.')
  } catch (err) {
    return classifyFailure(err, req)
  } finally {
    clearTimeout(timer)
  }
}

// ── Failure classification ─────────────────────────────────────────────────

/** Classify an arbitrary thrown error into a `ProbeResult` failure. */
export function classifyFailure(err: unknown, _req?: ProbeRequest): ProbeResult {
  if (isAuthRejection(err)) {
    return FAIL(
      'auth-rejected',
      'Provider rejected the credential. Re-authenticate and try again.',
    )
  }
  if (isConnectivityError(err)) {
    const message = err instanceof Error ? err.message : String(err)
    return FAIL('unreachable', `Cannot reach provider: ${message}`)
  }
  // Unknown error — be honest, don't pretend.
  const message = err instanceof Error ? err.message : String(err)
  return FAIL('server-error', `Probe failed: ${message}`)
}
