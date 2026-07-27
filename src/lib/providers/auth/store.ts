/**
 * Auth store — persists per-provider credentials.
 *
 * Dual mode:
 *   - Electron wrapper: delegates to the main process via IPC. The main
 *     process writes to `electron-store` (a JSON file under the OS user
 *     config dir, never synced to a browser profile, never reachable from
 *     web content). The renderer caches the last-seen values so reads are
 *     synchronous after the first IPC round-trip.
 *   - Plain browser dev: writes to `localStorage`. Same shape. Same API.
 *
 * Either way, a `subscribe(listener)` API is exposed so the registry can
 * re-emit when credentials change (e.g. the main process broadcast after
 * a Settings save).
 *
 * Storage shape (versioned for future migration):
 *   brightcode.auth.v1 = { [providerId]: StoredCredential }
 *
 * Security TODO before any public release:
 *   - Add `encryptionKey` to electron-store (OS-derived or passphrase).
 *   - Move to OS keyring (keytar) for API keys; electron-store is fine for
 *     metadata, but tokens at rest should live in the keychain.
 */

import type { CLISource, ProviderCredential } from '../types'
import type { ProviderAccount } from '../types'
import { accountStore } from './account-store'

/** @deprecated Use ProviderAccount from types.ts instead. */
export interface StoredCredential {
  method: ProviderCredential['method']
  apiKey?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  cliSource?: CLISource
  cliEmail?: string
  metadata?: Record<string, unknown>
}

type Listener = () => void

const isElectron =
  typeof window !== 'undefined' && typeof window.electronAPI !== 'undefined'

function now(): number {
  return Date.now()
}

function toAccount(providerId: string, cred: StoredCredential, id = 'default', label = 'Default'): ProviderAccount {
  return {
    id,
    providerId,
    label,
    authMethod: cred.method,
    apiKey: cred.apiKey,
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    cliSource: cred.cliSource,
    cliEmail: cred.cliEmail,
    metadata: cred.metadata,
    enabled: true,
    lastUsedAt: now(),
    createdAt: now(),
  }
}

function toStored(account: ProviderAccount): StoredCredential {
  return {
    method: account.authMethod,
    apiKey: account.apiKey,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    cliSource: account.cliSource,
    cliEmail: account.cliEmail,
    metadata: account.metadata,
  }
}

/** Bridge from old StoredCredential format to accountStore's ProviderAccount.
 *  All public methods read/write via accountStore; the old `brightcode.auth.v1`
 *  localStorage key is no longer used directly (migrated on first accountStore read). */
export const authStore = {
  readAll(): Record<string, StoredCredential> {
    const all = accountStore.readAll()
    const out: Record<string, StoredCredential> = {}
    for (const [providerId] of Object.entries(all)) {
      const active = accountStore.getActiveAccount(providerId)
      if (active) {
        out[providerId] = toStored(active)
      }
    }
    return out
  },

  get(providerId: string): StoredCredential | undefined {
    const account = accountStore.getActiveAccount(providerId)
    return account ? toStored(account) : undefined
  },

  async set(providerId: string, credential: StoredCredential): Promise<void> {
    const existing = accountStore.getAccount(providerId, 'default')
    const account = toAccount(providerId, credential, 'default', existing?.label ?? 'Default')
    if (existing) {
      account.createdAt = existing.createdAt
    }
    await accountStore.addAccount(providerId, account)
  },

  async remove(providerId: string): Promise<void> {
    const accounts = accountStore.listAccounts(providerId)
    for (const acc of accounts) {
      await accountStore.removeAccount(providerId, acc.id)
    }
  },

  has(providerId: string): boolean {
    return accountStore.listAccounts(providerId).length > 0
  },

  list(): Array<{ providerId: string; credential: StoredCredential }> {
    const all = accountStore.readAll()
    const out: Array<{ providerId: string; credential: StoredCredential }> = []
    for (const [providerId] of Object.entries(all)) {
      const active = accountStore.getActiveAccount(providerId)
      const acc = active ?? accountStore.listAccounts(providerId)[0]
      if (acc) {
        out.push({ providerId, credential: toStored(acc) })
      }
    }
    return out
  },

  async clear(): Promise<void> {
    const all = accountStore.readAll()
    for (const [providerId] of Object.entries(all)) {
      for (const account of accountStore.listAccounts(providerId)) {
        await accountStore.removeAccount(providerId, account.id)
      }
    }
  },

  subscribe(listener: Listener): () => void {
    return accountStore.subscribe(listener)
  },

  async hydrate(): Promise<void> {
    await accountStore.hydrate()
  },

  isElectron,
}

export type { Listener as AuthStoreListener }
