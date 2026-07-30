import { useEffect, useState } from 'react'
import { getAppVersion } from '@/lib/tauri-api'

export function AppVersionBadge() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getAppVersion()
      .then((v) => {
        if (!cancelled) setVersion(v)
      })
      .catch(() => {
        if (!cancelled) setVersion(null)
      })
    return () => {
      cancelled = true
    }
  }, [])
  if (!version) return null
  return (
    <span className="text-xs text-muted-foreground" data-testid="app-version-badge">
      v{version}
    </span>
  )
}
