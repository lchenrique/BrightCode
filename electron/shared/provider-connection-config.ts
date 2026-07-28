/**
 * Provider connection config — pure, electron-free helpers.
 *
 * Mirrors `apps/desktop/electron/connection-config.ts` from hermes-agent:
 * keeps connection configuration as data, in one place, with no `import
 * 'electron'`, so it can be unit-tested with `node --test` and reused by
 * both the main process and the renderer (for connection-test previews).
 *
 * Concerns owned by this module:
 *   1. URL normalization (https?:// only, strip trailing slashes, …)
 *   2. Auth scheme classification (bearer | api-key | oauth | query-param)
 *   3. Auth header construction (the one place that decides header vs query)
 *   4. Auth-rejection vs connectivity-error distinction
 *   5. Probe-request construction (the smallest authenticated request that
 *      actually exercises the leg the app will use)
 *
 * Not owned here: how the credential is obtained, where it is stored, or
 * how it is refreshed. Those live in the auth store and `IAgentProvider`.
 */

import type { AuthMethod, ProviderCredential } from '../../src/lib/providers/types'

// ── Auth scheme ────────────────────────────────────────────────────────────

/**
 * The wire-level auth shape, distinct from how the credential was *obtained*
 * (which is `AuthMethod` from `src/lib/providers/types`).
 *
 * - `bearer`     → `Authorization: Bearer <token>`  (OpenAI, MiniMax, OpenCode, …)
 * - `api-key`    → `x-api-key: <key>`               (Anthropic)
 * - `oauth`      → `Authorization: Bearer <token>`  + refresh via stored refreshToken
 * - `query-param`→ `?key=<key>` in URL              (older Google endpoints)
 */
export type AuthScheme = 'bearer' | 'api-key' | 'oauth' | 'query-param'

/** Map a provider's `AuthMethod` to its `AuthScheme`. Pure. */
export function classifyAuthScheme(method: AuthMethod): AuthScheme {
  switch (method) {
    case 'api_key':
      return 'bearer' // default; can be overridden by provider-specific hint
    case 'oauth':
      return 'oauth'
    case 'cli_detected':
      // CLI tokens are bearer-shaped.
      return 'bearer'
  }
}

/**
 * Override for providers that use a non-bearer header (Anthropic is the
 * well-known one: `x-api-key` instead of `Authorization: Bearer`).
 * The provider's `credentialProviderId` is the canonical lookup; the
 * `authHeaderName` is provider metadata we read from the registry.
 */
export interface AuthSchemeOverride {
  scheme: AuthScheme
  /** Header name to use instead of `Authorization`. */
  headerName?: string
}

// ── URL normalization ──────────────────────────────────────────────────────

/**
 * Normalize a provider's base URL.
 *
 *   - Strip whitespace
 *   - Must be `http://` or `https://` (no `file:`, no `data:`, no relative)
 *   - Strip hash and search
 *   - Strip trailing slashes (so `${base}/v1/chat` and `${base}v1/chat` agree)
 *
 * Throws on invalid input — caller decides whether to surface the message
 * to the user (Settings → "URL is not valid: …") or to log and fall through.
 */
export function normalizeApiBaseUrl(rawUrl: string): string {
  const value = String(rawUrl ?? '').trim()
  if (!value) {
    throw new Error('Provider base URL is required.')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (err) {
    throw new Error(
      `Provider base URL is not valid: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Provider base URL must be http:// or https://, got ${parsed.protocol}`,
    )
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

// ── Auth header construction ───────────────────────────────────────────────

/**
 * Resolve the credential to a single token string. Pure.
 *
 *   - `api_key`  → uses `apiKey`
 *   - `oauth`    → uses `accessToken` (refresh is the caller's responsibility)
 *   - `cli_*`    → uses `accessToken` (falling back to `apiKey` for legacy shapes)
 *
 * Returns `null` if no usable token is present. Never throws.
 */
export function resolveToken(
  credential: ProviderCredential | undefined,
): string | null {
  if (!credential) return null
  if (credential.method === 'api_key' && credential.apiKey) return credential.apiKey
  if (credential.accessToken) return credential.accessToken
  if (credential.apiKey) return credential.apiKey
  return null
}

/**
 * Build the auth headers for a given scheme + credential.
 *
 * This is the ONE place that decides header vs query-param, so a future
 * change (e.g. adding `cookie` auth) is a single edit. The provider's
 * runtime code calls this instead of constructing headers inline.
 */
export function buildAuthHeaders(
  scheme: AuthScheme,
  credential: ProviderCredential | undefined,
  override?: AuthSchemeOverride,
): Record<string, string> {
  const token = resolveToken(credential)
  if (!token) return {}

  const headerName = override?.headerName
  switch (scheme) {
    case 'bearer':
    case 'oauth':
      return { Authorization: `Bearer ${token}` }
    case 'api-key':
      // Anthropic convention: `x-api-key` header.
      return { [headerName ?? 'x-api-key']: token }
    case 'query-param':
      // No header — query-param auth appends the key in the URL.
      return {}
  }
}

/**
 * Build a URL with query-param auth (only used by `query-param` scheme).
 * Returns the input unchanged for other schemes.
 */
export function applyQueryParamAuth(
  url: string,
  credential: ProviderCredential | undefined,
  paramName = 'key',
): string {
  const token = resolveToken(credential)
  if (!token) return url
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has(paramName)) {
      parsed.searchParams.set(paramName, token)
    }
    return parsed.toString()
  } catch {
    return url
  }
}

// ── Auth rejection vs connectivity ─────────────────────────────────────────

/**
 * Distinct from "request failed". An auth rejection is the *server* telling
 * the caller that the credential is wrong or expired — recovery means
 * re-authenticating. A connectivity error is the network, the proxy, a
 * timeout, or a malformed response — recovery means retrying or switching
 * backend.
 *
 * Hermes rule (mirrored): "An HTTP status probe passing while the
 * WebSocket/auth leg fails is a false positive that ships as 'it said
 * connected but nothing works'." Same idea for HTTP providers: a 200 on
 * an unauthenticated path that would 401 on the real path lies about
 * connectivity.
 */
export function isAuthRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  // 401 / 403 — explicit. 407 (proxy auth) is also an auth rejection.
  const status = (err as { status?: unknown; statusCode?: unknown }).status ??
    (err as { statusCode?: unknown }).statusCode
  if (status === 401 || status === 403 || status === 407) return true

  // Some fetch implementations throw TypeError on CORS / preflight failures;
  // those are connectivity, not auth.
  // Some throw named "AbortError" — caller-side cancellation, not auth.
  return false
}

export function isConnectivityError(err: unknown): boolean {
  if (!err) return false
  if (isAuthRejection(err)) return false

  const name = (err as { name?: unknown }).name
  if (name === 'AbortError' || name === 'CanceledError' || name === 'TimeoutError') {
    return true
  }
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') {
    // Node / undici error codes for transport-level failures.
    if (
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'EAI_AGAIN' ||
      code === 'UND_ERR_SOCKET' ||
      code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return true
    }
  }
  return false
}

// ── Probe request construction ─────────────────────────────────────────────

/**
 * Build the smallest request that exercises the same auth + transport the
 * app will use. For OpenAI-compatible providers this is `GET {base}/models`
 * (auth: bearer); for Anthropic this would be a tiny `messages` POST.
 *
 * The probe is intentionally tiny: a "looks alive" HEAD on an unauthenticated
 * path is a false positive (Hermes rule). We need the auth leg.
 *
 * The returned `ProbeRequest` is data — the actual fetch is performed by
 * `electron/shared/provider-probes.ts` (so it can be mocked in tests).
 */
export interface ProbeRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  /** Empty for GET; for POST, a tiny JSON body the provider will accept. */
  body?: string
}

export interface ProbeRequestSpec {
  baseUrl: string
  scheme: AuthScheme
  credential?: ProviderCredential
  /** Optional override of the probe path. Defaults to `/models` for GET. */
  probePath?: string
  override?: AuthSchemeOverride
}

/** Construct the probe request from a spec. */
export function resolveProbeRequest(spec: ProbeRequestSpec): ProbeRequest {
  const base = normalizeApiBaseUrl(spec.baseUrl)
  const headers = buildAuthHeaders(spec.scheme, spec.credential, spec.override)
  // Query-param scheme still goes through headers, but the key is appended to
  // the URL — see `applyQueryParamAuth`.
  const url = spec.scheme === 'query-param'
    ? applyQueryParamAuth(`${base}${spec.probePath ?? '/models'}`, spec.credential)
    : `${base}${spec.probePath ?? '/models'}`
  return {
    method: 'GET',
    url,
    headers,
  }
}

// ── Host label (UI display) ────────────────────────────────────────────────

/** Return a human-friendly host:port label, or null if the URL is invalid. */
export function hostLabelFromBaseUrl(baseUrl: string): string | null {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!parsed.hostname) return null
    return parsed.port && parsed.port !== '80' && parsed.port !== '443'
      ? `${parsed.hostname}:${parsed.port}`
      : parsed.hostname
  } catch {
    return null
  }
}

// ── Token preview (safe to show in UI) ─────────────────────────────────────

/** Return a non-secret preview of a token, or null if absent. */
export function tokenPreview(value: string | undefined | null): string | null {
  const raw = String(value ?? '')
  if (!raw) return null
  return raw.length <= 8 ? 'set' : `…${raw.slice(-6)}`
}
