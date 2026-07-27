import { useCallback, useRef, useSyncExternalStore } from 'react'
import { accountStore } from '@/lib/providers/auth/account-store'
import { providerRegistry } from '@/lib/providers'
import type { ProviderAccount } from '@/lib/providers'

function genId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  }
}

export function useProviderAccounts(providerId: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsub = accountStore.subscribe(onChange)
      const unsub2 = providerRegistry.subscribe(onChange)
      return () => {
        unsub()
        unsub2()
      }
    },
    [],
  )

  const cacheRef = useRef<{
    key: string
    value: {
      accounts: ProviderAccount[]
      activeAccount: ProviderAccount | undefined
    }
  } | null>(null)

  const getSnapshot = useCallback((): {
    accounts: ProviderAccount[]
    activeAccount: ProviderAccount | undefined
  } => {
    const accounts = accountStore.listAccounts(providerId)
    const activeAccount = accountStore.getActiveAccount(providerId)
    const key =
      accounts
        .map(
          (a) =>
            `${a.id}|${a.label}|${a.email ?? ''}|${a.cliEmail ?? ''}|${a.authMethod}|${a.enabled}|${a.lastUsedAt ?? 0}`,
        )
        .join(',') +
      '|' +
      (activeAccount?.id ?? '')
    const cached = cacheRef.current
    if (cached && cached.key === key) return cached.value
    const value = { accounts, activeAccount }
    cacheRef.current = { key, value }
    return value
  }, [providerId])

  const { accounts, activeAccount } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  )

  const setActive = useCallback(
    (accountId: string) => {
      void accountStore.setActiveAccount(providerId, accountId)
    },
    [providerId],
  )

  const addAccount = useCallback(
    async (label: string, credential?: string | Partial<ProviderAccount>) => {
      const id = genId()
      const base: ProviderAccount = {
        id,
        providerId,
        label,
        authMethod: 'api_key',
        enabled: true,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      }
      if (typeof credential === 'string') {
        base.apiKey = credential
      } else if (credential) {
        Object.assign(base, credential)
        base.authMethod = credential.authMethod ?? 'api_key'
      }
      await accountStore.addAccount(providerId, base)
    },
    [providerId],
  )

  const removeAccount = useCallback(
    async (accountId: string) => {
      await accountStore.removeAccount(providerId, accountId)
    },
    [providerId],
  )

  const updateAccount = useCallback(
    async (accountId: string, patch: Partial<ProviderAccount>) => {
      await accountStore.updateAccount(providerId, accountId, patch)
    },
    [providerId],
  )

  return { accounts, activeAccount, setActive, addAccount, removeAccount, updateAccount }
}
