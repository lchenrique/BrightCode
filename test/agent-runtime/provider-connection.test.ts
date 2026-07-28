/**
 * Provider connection tests — covers the pure helpers + probe + state machine.
 *
 * Mirrors the hermes-agent pattern of testing pure helpers with `node --test`
 * (we use vitest, same effect): no electron runtime, just fetch stubs.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  applyQueryParamAuth,
  buildAuthHeaders,
  classifyAuthScheme,
  hostLabelFromBaseUrl,
  isAuthRejection,
  isConnectivityError,
  normalizeApiBaseUrl,
  resolveProbeRequest,
  resolveToken,
  tokenPreview,
  type AuthSchemeOverride,
  type FetchLike,
} from '../../electron/shared/provider-connection-config'
import { probeProvider, classifyFailure } from '../../electron/shared/provider-probes'
import {
  ProviderConnectionState,
} from '../../electron/main/provider-connection-state'
import type { ProviderCredential } from '../../src/lib/providers/types'

// ── Test fixtures ───────────────────────────────────────────────────────────

const bearerCred: ProviderCredential = {
  method: 'api_key',
  apiKey: 'sk-test-12345678',
}
const oauthCred: ProviderCredential = {
  method: 'oauth',
  accessToken: 'gho_abcdef1234567890',
  refreshToken: 'ghr_refresh',
  expiresAt: Date.now() + 3600_000,
}
const cliCred: ProviderCredential = {
  method: 'cli_detected',
  accessToken: 'cli-token-xyz',
  cliSource: 'codex-auth.json',
}
const anthropicOverride: AuthSchemeOverride = {
  scheme: 'api-key',
  headerName: 'x-api-key',
}

// ── URL normalization ──────────────────────────────────────────────────────

describe('normalizeApiBaseUrl', () => {
  it('accepts https URLs', () => {
    expect(normalizeApiBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })

  it('accepts http (loopback) URLs', () => {
    expect(normalizeApiBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1')
  })

  it('strips trailing slashes', () => {
    expect(normalizeApiBaseUrl('https://api.openai.com/v1///')).toBe('https://api.openai.com/v1')
  })

  it('strips search and hash', () => {
    expect(normalizeApiBaseUrl('https://api.openai.com/v1?token=x#frag')).toBe('https://api.openai.com/v1')
  })

  it('trims whitespace', () => {
    expect(normalizeApiBaseUrl('  https://api.openai.com/v1  ')).toBe('https://api.openai.com/v1')
  })

  it('rejects empty string', () => {
    expect(() => normalizeApiBaseUrl('')).toThrow(/required/i)
  })

  it('rejects whitespace-only string', () => {
    expect(() => normalizeApiBaseUrl('   ')).toThrow(/required/i)
  })

  it('rejects non-http protocols', () => {
    expect(() => normalizeApiBaseUrl('file:///etc/passwd')).toThrow(/http/)
    expect(() => normalizeApiBaseUrl('data:text/plain,hello')).toThrow(/http/)
    expect(() => normalizeApiBaseUrl('ftp://example.com')).toThrow(/http/)
  })

  it('rejects malformed URLs', () => {
    expect(() => normalizeApiBaseUrl('not a url')).toThrow(/not valid/i)
    expect(() => normalizeApiBaseUrl('https://')).toThrow() // URL parser may accept or reject
  })
})

// ── Auth scheme classification ─────────────────────────────────────────────

describe('classifyAuthScheme', () => {
  it('api_key → bearer (default)', () => {
    expect(classifyAuthScheme('api_key')).toBe('bearer')
  })

  it('oauth → oauth', () => {
    expect(classifyAuthScheme('oauth')).toBe('oauth')
  })

  it('cli_detected → bearer', () => {
    expect(classifyAuthScheme('cli_detected')).toBe('bearer')
  })
})

// ── Token resolution ───────────────────────────────────────────────────────

describe('resolveToken', () => {
  it('returns apiKey for api_key', () => {
    expect(resolveToken(bearerCred)).toBe('sk-test-12345678')
  })

  it('returns accessToken for oauth', () => {
    expect(resolveToken(oauthCred)).toBe('gho_abcdef1234567890')
  })

  it('returns accessToken for cli_detected', () => {
    expect(resolveToken(cliCred)).toBe('cli-token-xyz')
  })

  it('returns null when no credential is supplied', () => {
    expect(resolveToken(undefined)).toBeNull()
  })

  it('returns null when credential is empty', () => {
    expect(resolveToken({ method: 'api_key' })).toBeNull()
  })
})

// ── Auth header construction ───────────────────────────────────────────────

describe('buildAuthHeaders', () => {
  it('bearer: Authorization header', () => {
    expect(buildAuthHeaders('bearer', bearerCred)).toEqual({
      Authorization: 'Bearer sk-test-12345678',
    })
  })

  it('oauth: Authorization header (same as bearer, refresh is caller responsibility)', () => {
    expect(buildAuthHeaders('oauth', oauthCred)).toEqual({
      Authorization: 'Bearer gho_abcdef1234567890',
    })
  })

  it('api-key default: x-api-key header', () => {
    expect(buildAuthHeaders('api-key', bearerCred)).toEqual({
      'x-api-key': 'sk-test-12345678',
    })
  })

  it('api-key with override (Anthropic case)', () => {
    expect(buildAuthHeaders('api-key', bearerCred, anthropicOverride)).toEqual({
      'x-api-key': 'sk-test-12345678',
    })
  })

  it('query-param: no header (key goes in URL)', () => {
    expect(buildAuthHeaders('query-param', bearerCred)).toEqual({})
  })

  it('returns empty headers when no token is available', () => {
    expect(buildAuthHeaders('bearer', undefined)).toEqual({})
    expect(buildAuthHeaders('bearer', { method: 'api_key' })).toEqual({})
  })
})

// ── Query-param URL ────────────────────────────────────────────────────────

describe('applyQueryParamAuth', () => {
  it('appends the key parameter', () => {
    expect(applyQueryParamAuth('https://api.example.com/v1', bearerCred)).toBe(
      'https://api.example.com/v1?key=sk-test-12345678',
    )
  })

  it('does not overwrite an existing key', () => {
    expect(applyQueryParamAuth('https://api.example.com/v1?key=existing', bearerCred)).toBe(
      'https://api.example.com/v1?key=existing',
    )
  })

  it('uses a custom param name', () => {
    expect(applyQueryParamAuth('https://api.example.com/v1', bearerCred, 'api_key')).toBe(
      'https://api.example.com/v1?api_key=sk-test-12345678',
    )
  })

  it('returns the URL unchanged when no credential', () => {
    expect(applyQueryParamAuth('https://api.example.com/v1', undefined)).toBe(
      'https://api.example.com/v1',
    )
  })

  it('returns the URL unchanged on invalid URL', () => {
    expect(applyQueryParamAuth('not a url', bearerCred)).toBe('not a url')
  })
})

// ── Auth rejection vs connectivity ─────────────────────────────────────────

describe('isAuthRejection', () => {
  it('recognises 401', () => {
    expect(isAuthRejection({ status: 401 })).toBe(true)
  })
  it('recognises 403', () => {
    expect(isAuthRejection({ status: 403 })).toBe(true)
  })
  it('recognises 407 (proxy auth)', () => {
    expect(isAuthRejection({ status: 407 })).toBe(true)
  })
  it('rejects 200', () => {
    expect(isAuthRejection({ status: 200 })).toBe(false)
  })
  it('rejects 500 (server-error, not auth)', () => {
    expect(isAuthRejection({ status: 500 })).toBe(false)
  })
  it('accepts both status and statusCode shapes', () => {
    expect(isAuthRejection({ statusCode: 401 })).toBe(true)
  })
  it('rejects null/undefined', () => {
    expect(isAuthRejection(null)).toBe(false)
    expect(isAuthRejection(undefined)).toBe(false)
    expect(isAuthRejection({})).toBe(false)
  })
})

describe('isConnectivityError', () => {
  it('recognises AbortError', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(isConnectivityError(err)).toBe(true)
  })
  it('recognises TimeoutError', () => {
    const err = Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    expect(isConnectivityError(err)).toBe(true)
  })
  it('recognises ECONNREFUSED', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    expect(isConnectivityError(err)).toBe(true)
  })
  it('recognises ENOTFOUND', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' })
    expect(isConnectivityError(err)).toBe(true)
  })
  it('rejects 401 (it is auth, not connectivity)', () => {
    expect(isConnectivityError({ status: 401 })).toBe(false)
  })
  it('rejects plain Error without name/code', () => {
    expect(isConnectivityError(new Error('boom'))).toBe(false)
  })
})

// ── Probe request construction ─────────────────────────────────────────────

describe('resolveProbeRequest', () => {
  it('builds a GET to /models with bearer auth', () => {
    const req = resolveProbeRequest({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
    })
    expect(req.method).toBe('GET')
    expect(req.url).toBe('https://api.openai.com/v1/models')
    expect(req.headers).toEqual({ Authorization: 'Bearer sk-test-12345678' })
  })

  it('uses x-api-key for Anthropic', () => {
    const req = resolveProbeRequest({
      baseUrl: 'https://api.anthropic.com/v1',
      scheme: 'api-key',
      credential: bearerCred,
      override: anthropicOverride,
    })
    expect(req.url).toBe('https://api.anthropic.com/v1/models')
    expect(req.headers).toEqual({ 'x-api-key': 'sk-test-12345678' })
  })

  it('appends key in URL for query-param scheme', () => {
    const req = resolveProbeRequest({
      baseUrl: 'https://api.example.com',
      scheme: 'query-param',
      credential: bearerCred,
    })
    expect(req.url).toContain('?key=sk-test-12345678')
    expect(req.headers).toEqual({})
  })

  it('respects custom probePath', () => {
    const req = resolveProbeRequest({
      baseUrl: 'https://api.example.com',
      scheme: 'bearer',
      credential: bearerCred,
      probePath: '/v1/health',
    })
    expect(req.url).toBe('https://api.example.com/v1/health')
  })

  it('throws on invalid base URL', () => {
    expect(() =>
      resolveProbeRequest({ baseUrl: 'not a url', scheme: 'bearer' }),
    ).toThrow(/not valid/i)
  })
})

// ── Display helpers ────────────────────────────────────────────────────────

describe('hostLabelFromBaseUrl', () => {
  it('returns hostname for default port', () => {
    expect(hostLabelFromBaseUrl('https://api.openai.com/v1')).toBe('api.openai.com')
  })
  it('includes port when non-default', () => {
    expect(hostLabelFromBaseUrl('http://localhost:11434/v1')).toBe('localhost:11434')
  })
  it('returns null on invalid URL', () => {
    expect(hostLabelFromBaseUrl('not a url')).toBeNull()
  })
  it('returns null on empty', () => {
    expect(hostLabelFromBaseUrl('')).toBeNull()
  })
})

describe('tokenPreview', () => {
  it('shows last 6 chars for long tokens', () => {
    expect(tokenPreview('sk-abcdefghij12345678')).toBe('…345678')
  })
  it('shows "set" for short tokens', () => {
    expect(tokenPreview('short')).toBe('set')
  })
  it('returns null for empty', () => {
    expect(tokenPreview('')).toBeNull()
    expect(tokenPreview(null)).toBeNull()
    expect(tokenPreview(undefined)).toBeNull()
  })
})

// ── Probe (with fetch stub) ────────────────────────────────────────────────

function makeFetch(status: number, body = '{}'): FetchLike {
  return vi.fn(async () => ({
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  })) as unknown as FetchLike
}

describe('probeProvider', () => {
  it('returns connected on 200', async () => {
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: makeFetch(200),
    })
    expect(result.status).toBe('connected')
    expect(result.latencyMs).toBeTypeOf('number')
  })

  it('returns auth-rejected on 401', async () => {
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: makeFetch(401),
    })
    expect(result.status).toBe('auth-rejected')
    expect(result.message).toMatch(/rejected/i)
  })

  it('returns auth-rejected on 403', async () => {
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: makeFetch(403),
    })
    expect(result.status).toBe('auth-rejected')
  })

  it('returns server-error on 500', async () => {
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: makeFetch(500),
    })
    expect(result.status).toBe('server-error')
  })

  it('returns misconfigured on 404 (auth passed but probe path wrong)', async () => {
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: makeFetch(404),
    })
    expect(result.status).toBe('misconfigured')
    expect(result.message).toMatch(/not found/i)
  })

  it('returns unreachable on network failure', async () => {
    const err = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
    const failingFetch: FetchLike = vi.fn(async () => {
      throw err
    }) as unknown as FetchLike
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: failingFetch,
    })
    expect(result.status).toBe('unreachable')
  })

  it('returns misconfigured when no credential is supplied', async () => {
    const result = await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: undefined,
      fetch: makeFetch(200),
    })
    expect(result.status).toBe('misconfigured')
    expect(result.message).toMatch(/credential/i)
  })

  it('returns misconfigured on invalid base URL', async () => {
    const result = await probeProvider({
      baseUrl: 'not a url',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: makeFetch(200),
    })
    expect(result.status).toBe('misconfigured')
  })

  it('sends the auth header (probes the real leg)', async () => {
    const fetchSpy = makeFetch(200)
    await probeProvider({
      baseUrl: 'https://api.openai.com/v1',
      scheme: 'bearer',
      credential: bearerCred,
      fetch: fetchSpy,
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer sk-test-12345678' },
      }),
    )
  })

  it('sends x-api-key for Anthropic (override)', async () => {
    const fetchSpy = makeFetch(200)
    await probeProvider({
      baseUrl: 'https://api.anthropic.com',
      scheme: 'api-key',
      credential: bearerCred,
      override: anthropicOverride,
      probePath: '/v1/messages',
      fetch: fetchSpy,
    })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        headers: { 'x-api-key': 'sk-test-12345678' },
      }),
    )
  })
})

// ── classifyFailure (helper) ───────────────────────────────────────────────

describe('classifyFailure', () => {
  it('auth error → auth-rejected', () => {
    expect(classifyFailure({ status: 401 }).status).toBe('auth-rejected')
  })
  it('connectivity → unreachable', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    expect(classifyFailure(err).status).toBe('unreachable')
  })
  it('unknown → server-error', () => {
    expect(classifyFailure(new Error('weird')).status).toBe('server-error')
  })
})

// ── State machine ──────────────────────────────────────────────────────────

describe('ProviderConnectionState', () => {
  it('starts empty', () => {
    const state = new ProviderConnectionState()
    expect(state.getSnapshot()).toEqual({})
    expect(state.getVersion()).toBe(0)
  })

  it('probe transitions through probing → connected', async () => {
    const state = new ProviderConnectionState({ fetch: makeFetch(200) })
    const states: string[] = []
    state.subscribe(() => {
      const snap = state.getSnapshot()
      states.push(snap['openai']?.status ?? 'missing')
    })
    await state.probe({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authMethod: 'api_key',
      credential: bearerCred,
    })
    expect(states).toContain('probing')
    expect(states[states.length - 1]).toBe('connected')
  })

  it('records auth-rejected as terminal', async () => {
    const state = new ProviderConnectionState({ fetch: makeFetch(401) })
    await state.probe({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authMethod: 'api_key',
      credential: bearerCred,
    })
    const entry = state.get('openai')
    expect(entry?.status).toBe('auth-rejected')
    expect(entry?.probing).toBe(false)
  })

  it('reset() removes the entry', async () => {
    const state = new ProviderConnectionState({ fetch: makeFetch(200) })
    await state.probe({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authMethod: 'api_key',
      credential: bearerCred,
    })
    expect(state.get('openai')).toBeDefined()
    state.reset('openai')
    expect(state.get('openai')).toBeUndefined()
  })

  it('flagMisconfigured() sets without probing', () => {
    const state = new ProviderConnectionState()
    state.flagMisconfigured('openai', 'URL was rejected at save')
    const entry = state.get('openai')
    expect(entry?.status).toBe('misconfigured')
    expect(entry?.message).toBe('URL was rejected at save')
  })

  it('clear() removes all entries', async () => {
    const state = new ProviderConnectionState({ fetch: makeFetch(200) })
    await state.probeAll([
      {
        providerId: 'a',
        baseUrl: 'https://a.example.com',
        authMethod: 'api_key',
        credential: bearerCred,
      },
      {
        providerId: 'b',
        baseUrl: 'https://b.example.com',
        authMethod: 'api_key',
        credential: bearerCred,
      },
    ])
    expect(Object.keys(state.getSnapshot())).toHaveLength(2)
    state.clear()
    expect(state.getSnapshot()).toEqual({})
  })

  it('persists on flush (when persist sink is set)', async () => {
    const persisted: Record<string, unknown>[] = []
    const state = new ProviderConnectionState({
      fetch: makeFetch(200),
      persist: (entries) => persisted.push({ ...entries }),
    })
    await state.probe({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authMethod: 'api_key',
      credential: bearerCred,
    })
    expect(persisted.length).toBeGreaterThan(0)
    const last = persisted[persisted.length - 1]
    expect(last['openai']).toBeDefined()
  })

  it('loads last-known state on construction', () => {
    const state = new ProviderConnectionState({
      load: () => ({
        openai: {
          providerId: 'openai',
          status: 'connected',
          latencyMs: 123,
          testedAt: '2026-01-01T00:00:00.000Z',
          probing: false,
        },
      }),
    })
    const entry = state.get('openai')
    expect(entry?.status).toBe('connected')
    expect(entry?.latencyMs).toBe(123)
    // Loaded entries are never 'probing' (the actual probe is over).
    expect(entry?.probing).toBe(false)
  })

  it('a stale in-flight probe does not overwrite a newer one', async () => {
    let slowResolve: (v: unknown) => void = () => {}
    const slowFetch: FetchLike = vi.fn(
      (_url, init) =>
        new Promise((resolve) => {
          // Respect the abort signal so the test doesn't hang.
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              resolve({
                status: 0,
                ok: false,
                text: async () => '',
                json: async () => ({}),
              })
            })
          }
          slowResolve = resolve
        }),
    ) as unknown as FetchLike
    const state = new ProviderConnectionState({ fetch: slowFetch })
    const v1 = state.getVersion()

    // First probe (will be cancelled when the second starts)
    const p1 = state.probe({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authMethod: 'api_key',
      credential: bearerCred,
    })

    // Second probe (fast, succeeds immediately)
    const p2 = state.probe({
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      authMethod: 'api_key',
      credential: bearerCred,
      fetch: makeFetch(200),
    })
    // Resolve the slow first probe in case the abort didn't fire
    slowResolve({
      status: 200,
      statusText: 'OK',
      ok: true,
      text: async () => '{}',
      json: async () => ({}),
    })

    await Promise.all([p1, p2])
    // Version should have bumped (multiple updates)
    expect(state.getVersion()).toBeGreaterThan(v1)
    // Final state is connected (the newer probe won)
    expect(state.get('openai')?.status).toBe('connected')
  })
})
