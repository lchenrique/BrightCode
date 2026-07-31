/**
 * Hook for reading CLI-detected credentials from the main process.
 *
 * The detector runs in the Electron main process because it needs to read
 * OS keyrings and `~/.codex/auth.json`-style files. The renderer just
 * fetches the results via IPC and caches them.
 *
 * Returns the detection for a given provider id, plus a refetch function
 * that the Settings UI uses when the user runs `codex login` in a
 * separate terminal and comes back.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CLIDetection, DetectedProviderId } from '@/lib/electron-api-types'

/** Detected status for a single provider. */
export interface CLIDetectionState {
  detection: CLIDetection | null
  /** True while the first detection is in flight. */
  loading: boolean
  /** Error message if the IPC call itself failed (e.g. preload missing). */
  error: string | null
}

/**
 * Reactive hook: detects a single CLI credential for the given provider.
 * Refetches when `refreshKey` changes (e.g. when the user clicks "Re-scan").
 */
export function useCLIDetection(
  providerId: DetectedProviderId,
  refreshKey: unknown = 0,
): CLIDetectionState & { refetch: () => void } {
  const [state, setState] = useState<CLIDetectionState>({
    detection: null,
    loading: true,
    error: null,
  })

  const run = useCallback(() => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      setState({
        detection: null,
        loading: false,
        error: 'CLI detection requires the desktop app.',
      })
      return
    }
    setState((s) => ({ ...s, loading: true, error: null }))
    void window.electronAPI.cli
      .detect(providerId)
      .then((detection) => setState({ detection, loading: false, error: null }))
      .catch((err: unknown) =>
        setState({
          detection: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
  }, [providerId])

  useEffect(() => {
    run()
  }, [run, refreshKey])

  return { ...state, refetch: run }
}

/**
 * Run all detectors at once. Used on Settings open so the user sees a
 * full picture without having to click each card.
 */
export function useAllCLIDetection(refreshKey: unknown = 0): {
  detections: CLIDetection[]
  loading: boolean
  error: string | null
  refetch: () => void
} {
  const [detections, setDetections] = useState<CLIDetection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(() => {
    if (typeof window === 'undefined' || !window.electronAPI) {
      setError('CLI detection requires the desktop app.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void window.electronAPI.cli
      .detectAll()
      .then((list) => {
        setDetections(list)
        setLoading(false)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    run()
  }, [run, refreshKey])

  return { detections, loading, error, refetch: run }
}
