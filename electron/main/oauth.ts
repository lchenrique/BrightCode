/**
 * OAuth 2.0 PKCE Authorization Code Flow for BrightCode (Electron Main Process).
 *
 * Pattern inspired by 9Router & Orkas:
 *   1. Generates PKCE code_verifier + SHA-256 code_challenge and a random state token.
 *   2. Starts a transient local HTTP server (http://127.0.0.1:<port>/callback).
 *   3. Opens the system browser (shell.openExternal) with the provider's authorization URL.
 *   4. Listens for the redirect callback, sends a clean HTML "Authentication Successful" response
 *      with auto-closing tab script, and shuts down the local server.
 *   5. Performs the POST token exchange for access_token / refresh_token / expires_in.
 */

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import { URL } from 'node:url'
import { ipcMain, shell } from 'electron'
import { IPC } from '../shared/ipc-channels'

export interface OAuthConfig {
  providerId: string
  clientId: string
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  codeChallengeMethod?: 'S256' | 'plain'
  contentType?: 'application/x-www-form-urlencoded' | 'application/json'
  extraAuthParams?: Record<string, string>
  fixedPort?: number
  callbackPath?: string
  callbackHost?: string
}

export interface OAuthResult {
  ok: true
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  email?: string
  accountId?: string
  idToken?: string
}

export interface OAuthErrorResult {
  ok: false
  error: string
}

// ── PKCE Helper ────────────────────────────────────────────────────────

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export function generatePKCE() {
  const verifierBytes = randomBytes(32)
  const codeVerifier = base64UrlEncode(verifierBytes)
  const codeChallenge = base64UrlEncode(
    createHash('sha256').update(codeVerifier).digest(),
  )
  const state = base64UrlEncode(randomBytes(16))
  return { codeVerifier, codeChallenge, state }
}

// ── Local HTTP Callback Server ─────────────────────────────────────────

interface PendingOAuth {
  state: string
  resolve: (res: OAuthResult | OAuthErrorResult) => void
  closeServer: () => void
}

let activeOAuth: PendingOAuth | null = null

export function cancelOAuthFlow(reason = 'Cancelled by user'): void {
  if (!activeOAuth) return
  const current = activeOAuth
  activeOAuth = null
  current.closeServer()
  current.resolve({ ok: false, error: reason })
}

function startLocalCallbackServer(
  _state: string,
  port: number | undefined,
  onCallback: (params: Record<string, string>) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname === '/callback' || url.pathname === '/auth/callback') {
        const params = Object.fromEntries(url.searchParams)

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>BrightCode — Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0c10; color: #f3f4f6; }
    .card { text-align: center; padding: 2.5rem; background: #161b22; border: 1px solid #30363d; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); max-width: 400px; }
    .icon { color: #22c55e; font-size: 3.5rem; margin-bottom: 0.5rem; }
    h1 { margin: 0.5rem 0; font-size: 1.5rem; font-weight: 600; }
    p { color: #8b949e; font-size: 0.95rem; margin-top: 0.5rem; }
    #countdown { font-weight: bold; color: #60a5fa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10003;</div>
    <h1>Authentication Successful</h1>
    <p>You can return to BrightCode.</p>
    <p id="msg">Closing in <span id="countdown">3</span> seconds...</p>
  </div>
  <script>
    let n = 3;
    const el = document.getElementById("countdown");
    const timer = setInterval(() => {
      n--;
      if (el) el.textContent = n;
      if (n <= 0) {
        clearInterval(timer);
        window.close();
      }
    }, 1000);
  </script>
</body>
</html>`)

        onCallback(params)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    server.listen(port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        close: () => {
          try {
            server.close()
          } catch {
            // ignore
          }
        },
      })
    })

    server.on('error', (err) => reject(err))
  })
}

// ── Main OAuth Flow Runner ─────────────────────────────────────────────

export async function runOAuthFlow(config: OAuthConfig): Promise<OAuthResult | OAuthErrorResult> {
  // Cancel any prior flow
  cancelOAuthFlow('Superseded by new authentication attempt')

  const { codeVerifier, codeChallenge, state } = generatePKCE()

  let callbackParams: Record<string, string> | null = null
  let serverInfo: { port: number; close: () => void }

  try {
    serverInfo = await startLocalCallbackServer(state, config.fixedPort, (params) => {
      callbackParams = params
    })
  } catch (err) {
    return { ok: false, error: `Failed to start local callback server: ${(err as Error).message}` }
  }

  const redirectUri = `http://${config.callbackHost ?? '127.0.0.1'}:${serverInfo.port}${config.callbackPath ?? '/callback'}`

  // Build Auth URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: config.codeChallengeMethod ?? 'S256',
    scope: config.scopes.join(' '),
    ...(config.extraAuthParams ?? {}),
  })

  // Codex/OpenAI's OAuth client expects spaces in `scope` as `%20`.
  // URLSearchParams serializes them as `+`, which can be rejected by Hydra
  // as an invalid authorization request.
  const authUrl = `${config.authorizeUrl}?${params.toString().replace(/\+/g, '%20')}`

  return new Promise<OAuthResult | OAuthErrorResult>((resolve) => {
    const timeout = setTimeout(() => {
      cancelOAuthFlow('Authentication timed out (5 minutes)')
    }, 5 * 60 * 1000)

    activeOAuth = {
      state,
      resolve: (res) => {
        clearTimeout(timeout)
        resolve(res)
      },
      closeServer: serverInfo.close,
    }

    // Open System Browser
    shell.openExternal(authUrl).catch((err) => {
      cancelOAuthFlow(`Failed to open browser: ${(err as Error).message}`)
    })

    // Poll for callback parameter arrival
    const interval = setInterval(async () => {
      if (!callbackParams) return
      clearInterval(interval)
      clearTimeout(timeout)
      serverInfo.close()
      activeOAuth = null

      if (callbackParams.error) {
        resolve({
          ok: false,
          error: callbackParams.error_description || callbackParams.error,
        })
        return
      }

      if (callbackParams.state !== state) {
        resolve({ ok: false, error: 'OAuth state mismatch (CSRF warning)' })
        return
      }

      const code = callbackParams.code
      if (!code) {
        resolve({ ok: false, error: 'No authorization code received' })
        return
      }

      // Perform Token Exchange
      try {
        const tokenRes = await exchangeCode(config, code, redirectUri, codeVerifier)
        resolve(tokenRes)
      } catch (err) {
        resolve({ ok: false, error: `Token exchange failed: ${(err as Error).message}` })
      }
    }, 100)
  })
}

async function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<OAuthResult | OAuthErrorResult> {
  const isJson = config.contentType === 'application/json'

  const body = isJson
    ? JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      })
    : new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code: code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }).toString()

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': isJson
        ? 'application/json'
        : 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  if (!res.ok) {
    const errorText = await res.text()
    return { ok: false, error: `HTTP ${res.status}: ${errorText}` }
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: { email?: string };
    email?: string;
    id_token?: string;
  }

  if (!json.access_token) {
    return { ok: false, error: 'Response missing access_token' }
  }

  const accountId = extractOpenAIAccountId(json.id_token) ?? extractOpenAIAccountId(json.access_token)

  const expiresAt = typeof json.expires_in === 'number'
    ? Date.now() + json.expires_in * 1000
    : undefined

  return {
    ok: true,
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt,
    email: json.user?.email || json.email,
    accountId,
    idToken: json.id_token,
  }
}

function extractOpenAIAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth']
    return auth && typeof auth === 'object' && typeof (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id === 'string'
      ? (auth as { chatgpt_account_id: string }).chatgpt_account_id
      : undefined
  } catch {
    return undefined
  }
}

// ── IPC Registration ───────────────────────────────────────────────────

export function registerOAuthIpc(): void {
  ipcMain.handle(IPC.OAUTH_START, async (_e, config: OAuthConfig) => {
    return runOAuthFlow(config)
  })

  ipcMain.handle(IPC.OAUTH_CANCEL, () => {
    cancelOAuthFlow()
  })
}
