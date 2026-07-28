import { useCallback, useEffect, useState } from 'react'
import type { BrightMemoryStatus } from '../../electron/preload'

const EMPTY_STATUS: BrightMemoryStatus = {
  cliInstalled: false,
  globalRuleConfigured: false,
  rulePaths: [],
  ready: false,
}

export function useBrightMemory() {
  const [status, setStatus] = useState<BrightMemoryStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.brightMemory) {
      setStatus(EMPTY_STATUS)
      setError('Bright Memory setup requires the BrightCode desktop app.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      setStatus(await window.electronAPI.brightMemory.status())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  const install = useCallback(async () => {
    if (!window.electronAPI?.brightMemory || installing) return
    setInstalling(true)
    setError(null)
    try {
      const result = await window.electronAPI.brightMemory.install()
      setStatus(result.status)
      if (!result.ok) setError(result.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setInstalling(false)
    }
  }, [installing])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, loading, installing, error, refresh, install }
}
