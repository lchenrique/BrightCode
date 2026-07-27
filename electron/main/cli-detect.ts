/**
 * CLI detection — reads credentials already saved by local AI CLIs.
 *
 * Each detector tries the file-based store first, then falls back to the
 * OS keyring (via `keytar`). The two paths come from official docs:
 *
 *  Codex          — `~/.codex/auth.json` (Win: `%USERPROFILE%\.codex\auth.json`)
 *                   keyring service: "Codex Auth" (derived from CODEX_HOME)
 *  Claude Code    — `~/.claude/.credentials.json` (Win: `%USERPROFILE%\.claude\.credentials.json`)
 *                   macOS Keychain "claude-code" / Win Credential Manager
 *  Gemini CLI     — `~/.gemini/oauth_creds.json` (Win: `%USERPROFILE%\.gemini\oauth_creds.json`)
 *                   keyring service: "gemini-cli"
 *  Antigravity    — keyring only (no file fallback)
 *
 * The shape returned is a `CLIDetection` that can be passed directly to
 * `authStore.set()` as a `cli_detected` credential.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// keytar is optional — the file path detection works without it. We only
// load it when we actually need the keyring branch. Wrapping in try/catch
// because the native module may fail to load on some systems (e.g. missing
// libsecret-1 on Linux without it installed).
let keytar: typeof import('keytar') | null = null
function getKeytar(): typeof import('keytar') | null {
  if (keytar !== null) return keytar
  try {
    keytar = require('keytar')
    return keytar
  } catch {
    return null
  }
}

const IS_WINDOWS = process.platform === 'win32'
const HOME = homedir()

/** Maps a detected CLI to the BrightCode provider it should bind to. */
export type DetectedProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini-cli'
  | 'antigravity'
  | 'opencode-go'
  | 'opencode-zen'
  | 'minimax'

export type CLISource =
  | 'codex-auth.json'
  | 'codex-keyring'
  | 'claude-credentials'
  | 'claude-keyring'
  | 'gemini-oauth-creds'
  | 'gemini-keyring'
  | 'antigravity-keyring'
  | 'opencode-auth'

export interface CLIDetection {
  /** BrightCode provider id this credential is for. */
  providerId: DetectedProviderId
  /** Where we read it from. */
  source: CLISource
  /** Email or account label, if we can extract it without an extra API call. */
  accountLabel?: string
  /** OAuth access token, or raw API key. */
  accessToken: string
  /** OAuth refresh token, if present. */
  refreshToken?: string
  /** Epoch ms when the access token expires. */
  expiresAt?: number
}

// ── Path helpers ────────────────────────────────────────────────────────

function codexAuthPath(): string {
  const base = process.env['CODEX_HOME'] || join(HOME, IS_WINDOWS ? '.codex' : '.codex')
  return join(base, 'auth.json')
}

function codexKeyringService(): string {
  // Codex derives a stable service name from CODEX_HOME so multiple
  // installations don't collide. See the official docs:
  // https://developers.openai.com/codex/llms-full.txt
  const codexHome = process.env['CODEX_HOME'] || join(HOME, '.codex')
  const hash = createHash('sha256').update(codexHome).digest('hex').slice(0, 8)
  return `Codex Auth (${hash})`
}

function claudeCredentialsPath(): string {
  // CLAUDE_CONFIG_DIR is the documented override for the config dir.
  const configDir = process.env['CLAUDE_CONFIG_DIR'] || join(HOME, '.claude')
  // On macOS, the official docs say credentials live in the Keychain
  // (no file). We still try the file path because Linux/Windows use it
  // and a custom CLAUDE_CONFIG_DIR may place it on Mac too.
  if (IS_WINDOWS) {
    return join(configDir, '.credentials.json')
  }
  return join(configDir, '.credentials.json')
}

function geminiOAuthCredsPath(): string {
  return join(HOME, IS_WINDOWS ? '.gemini' : '.gemini', 'oauth_creds.json')
}

function geminiKeyringServiceCandidates(): string[] {
  // Both names appear in the wild; try them in order.
  return ['gemini-cli', 'Google OAuth', 'gemini-cli-oauth']
}

function antigravityKeyringServiceCandidates(): string[] {
  // Antigravity is a newer CLI and the exact service name is not
  // documented. We try a few likely candidates; first one wins.
  return ['gemini', 'Antigravity', 'antigravity', 'Google Antigravity', 'google-antigravity']
}

// ── File readers ────────────────────────────────────────────────────────

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── Detectors ───────────────────────────────────────────────────────────

/**
 * Codex CLI (OpenAI). Reads `auth.json` first, falls back to the keyring
 * entry whose service is derived from CODEX_HOME.
 */
export async function detectCodex(): Promise<CLIDetection | null> {
  const file = readJsonSafe(codexAuthPath())
  if (file) {
    // Codex auth.json shape (per docs):
    //   { OPENAI_API_KEY?: string, tokens?: { access_token, refresh_token, expires_at, id_token, account_id } }
    if (typeof file['OPENAI_API_KEY'] === 'string') {
      return {
        providerId: 'openai',
        source: 'codex-auth.json',
        accessToken: file['OPENAI_API_KEY'] as string,
        accountLabel: 'Codex (API key)',
      }
    }
    const tokens = file['tokens'] as Record<string, unknown> | undefined
    if (tokens && typeof tokens['access_token'] === 'string') {
      return {
        providerId: 'openai',
        source: 'codex-auth.json',
        accessToken: tokens['access_token'] as string,
        refreshToken: tokens['refresh_token'] as string | undefined,
        expiresAt: parseExpiresAt(tokens['expires_at']),
        accountLabel: accountLabelFromIdToken(tokens['id_token'] as string | undefined),
      }
    }
  }

  // Keyring fallback
  const kt = getKeytar()
  if (!kt) return null
  const cred = await kt.getPassword(codexKeyringService(), 'codex')
  if (cred) {
    try {
      const parsed = JSON.parse(cred) as Record<string, unknown>
      if (typeof parsed['access_token'] === 'string') {
        return {
          providerId: 'openai',
          source: 'codex-keyring',
          accessToken: parsed['access_token'] as string,
          refreshToken: parsed['refresh_token'] as string | undefined,
          expiresAt: parseExpiresAt(parsed['expires_at']),
          accountLabel: accountLabelFromIdToken(parsed['id_token'] as string | undefined),
        }
      }
    } catch {
      // raw string token
      return {
        providerId: 'openai',
        source: 'codex-keyring',
        accessToken: cred,
      }
    }
  }
  return null
}

/**
 * Claude Code (Anthropic). Reads `.credentials.json` first, then tries
 * a few Keychain service names. Note: on macOS, Claude Code is *only* in
 * the Keychain (no file). The keyring branch is what works there.
 */
export async function detectClaudeCode(): Promise<CLIDetection | null> {
  const file = readJsonSafe(claudeCredentialsPath())
  if (file) {
    // Claude Code .credentials.json shape (per Anthropic docs):
    //   { claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes, ... } }
    const oauth = (file['claudeAiOauth'] as Record<string, unknown> | undefined) ?? file
    if (typeof oauth['accessToken'] === 'string') {
      return {
        providerId: 'anthropic',
        source: 'claude-credentials',
        accessToken: oauth['accessToken'] as string,
        refreshToken: oauth['refreshToken'] as string | undefined,
        expiresAt: parseExpiresAt(oauth['expiresAt']),
        accountLabel: accountLabelFromIdToken(oauth['idToken'] as string | undefined),
      }
    }
  }

  // Keyring fallback (works on macOS where the file is absent).
  const kt = getKeytar()
  if (!kt) return null
  for (const service of ['claude-code', 'Claude Code', 'anthropic']) {
    const cred = await kt.getPassword(service, 'default')
    if (cred) {
      try {
        const parsed = JSON.parse(cred) as Record<string, unknown>
        const access =
          (parsed['accessToken'] as string | undefined) ??
          (parsed['access_token'] as string | undefined) ??
          cred
        return {
          providerId: 'anthropic',
          source: 'claude-keyring',
          accessToken: access,
          refreshToken:
            (parsed['refreshToken'] as string | undefined) ??
            (parsed['refresh_token'] as string | undefined),
          expiresAt: parseExpiresAt(parsed['expiresAt'] ?? parsed['expires_at']),
        }
      } catch {
        return {
          providerId: 'anthropic',
          source: 'claude-keyring',
          accessToken: cred,
        }
      }
    }
  }
  return null
}

/**
 * Gemini CLI (Google). Reads `oauth_creds.json` first, then keyring.
 * Shape: `{ access_token, refresh_token, scope, token_type, expiry_date, id_token, ... }`
 */
export async function detectGeminiCLI(): Promise<CLIDetection | null> {
  const file = readJsonSafe(geminiOAuthCredsPath())
  if (file && typeof file['access_token'] === 'string') {
    return {
      providerId: 'gemini-cli',
      source: 'gemini-oauth-creds',
      accessToken: file['access_token'] as string,
      refreshToken: file['refresh_token'] as string | undefined,
      expiresAt: parseExpiresAt(file['expiry_date'] ?? file['expires_at']),
      accountLabel: accountLabelFromIdToken(file['id_token'] as string | undefined),
    }
  }

  const kt = getKeytar()
  if (!kt) return null
  for (const service of geminiKeyringServiceCandidates()) {
    const cred = await kt.getPassword(service, 'default')
    if (cred) {
      try {
        const parsed = JSON.parse(cred) as Record<string, unknown>
        if (typeof parsed['access_token'] === 'string') {
          return {
            providerId: 'gemini-cli',
            source: 'gemini-keyring',
            accessToken: parsed['access_token'] as string,
            refreshToken: parsed['refresh_token'] as string | undefined,
            expiresAt: parseExpiresAt(parsed['expiry_date'] ?? parsed['expires_at']),
            accountLabel: accountLabelFromIdToken(parsed['id_token'] as string | undefined),
          }
        }
      } catch {
        return {
          providerId: 'gemini-cli',
          source: 'gemini-keyring',
          accessToken: cred,
        }
      }
    }
  }
  return null
}

/**
 * Antigravity CLI. Keyring only — no file fallback. We try a few likely
 * service names; the user can tell us the right one if none match.
 */
export async function detectAntigravity(): Promise<CLIDetection | null> {
  const kt = getKeytar()
  if (!kt) return null
  for (const service of antigravityKeyringServiceCandidates()) {
    const cred = await kt.getPassword(service, 'default')
    if (cred) {
      try {
        const parsed = JSON.parse(cred) as Record<string, unknown>
        const access =
          (parsed['access_token'] as string | undefined) ??
          (parsed['accessToken'] as string | undefined) ??
          cred
        return {
          providerId: 'antigravity',
          source: 'antigravity-keyring',
          accessToken: access,
          refreshToken:
            (parsed['refresh_token'] as string | undefined) ??
            (parsed['refreshToken'] as string | undefined),
          expiresAt: parseExpiresAt(parsed['expires_at'] ?? parsed['expiresAt']),
        }
      } catch {
        return {
          providerId: 'antigravity',
          source: 'antigravity-keyring',
          accessToken: cred,
        }
      }
    }
  }
  return null
}

/**
 * OpenCode CLI. Reads `~/.local/share/opencode/auth.json` (or `%USERPROFILE%\.local\share\opencode\auth.json`).
 * Shape: `{ "opencode-go": { key }, "opencode-zen": { key }, "minimax-coding-plan": { key } }`
 */
export async function detectOpenCode(): Promise<CLIDetection[]> {
  const authPath = join(HOME, '.local', 'share', 'opencode', 'auth.json')
  const file = readJsonSafe(authPath)
  if (!file) return []

  const detections: CLIDetection[] = []

  const go = file['opencode-go'] as Record<string, unknown> | undefined
  if (go && typeof go['key'] === 'string') {
    detections.push({
      providerId: 'opencode-go',
      source: 'opencode-auth',
      accessToken: go['key'] as string,
      accountLabel: 'OpenCode Go',
    })
  }

  const zen = file['opencode-zen'] as Record<string, unknown> | undefined
  if (zen && typeof zen['key'] === 'string') {
    detections.push({
      providerId: 'opencode-zen',
      source: 'opencode-auth',
      accessToken: zen['key'] as string,
      accountLabel: 'OpenCode Zen',
    })
  }

  const minimax = file['minimax-coding-plan'] as Record<string, unknown> | undefined
  if (minimax && typeof minimax['key'] === 'string') {
    detections.push({
      providerId: 'minimax',
      source: 'opencode-auth',
      accessToken: minimax['key'] as string,
      accountLabel: 'MiniMax (OpenCode)',
    })
  }

  return detections
}

/** Run all detectors in parallel. Failed ones are silently skipped. */
export async function detectAllCLIs(): Promise<CLIDetection[]> {
  const [singleResults, openCodeResults] = await Promise.all([
    Promise.allSettled([
      detectCodex(),
      detectClaudeCode(),
      detectGeminiCLI(),
      detectAntigravity(),
    ]),
    detectOpenCode().catch(() => []),
  ])

  const singles = singleResults
    .filter(
      (r): r is PromiseFulfilledResult<CLIDetection | null> => r.status === 'fulfilled',
    )
    .map((r) => r.value)
    .filter((d): d is CLIDetection => d !== null)

  return [...singles, ...openCodeResults]
}

// ── Token-shape helpers ────────────────────────────────────────────────

/** Accepts either an ISO string or epoch ms. */
function parseExpiresAt(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Best-effort account label from a JWT id_token. The payload is
 * base64url-encoded JSON with `email` / `name` / `sub`. We never verify
 * the signature — this is just for display, not auth.
 */
function accountLabelFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined
  const parts = idToken.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'),
    ) as Record<string, unknown>
    if (typeof payload['email'] === 'string') return payload['email']
    if (typeof payload['name'] === 'string') return payload['name']
    if (typeof payload['sub'] === 'string') return payload['sub']
  } catch {
    return undefined
  }
  return undefined
}
