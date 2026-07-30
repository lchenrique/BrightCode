import { useEffect, useState } from 'react'
import { getAppVersion } from '@/lib/tauri-api'

export function AppVersionBadge() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    getAppVersion().then(setVersion).catch(() => setVersion(null))
  }, [])
  if (!version) return null
  return (
    <span className="text-xs text-muted-foreground" data-testid="app-version-badge">
      v{version}
    </span>
  )
}
