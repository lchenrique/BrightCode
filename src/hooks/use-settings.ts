/**
 * useSettings — open the global Settings dialog from anywhere.
 *
 * The dialog itself is owned by `AppShell`. This hook lets any component
 * request "open settings" without prop-drilling, by dispatching a window
 * event that AppShell listens for.
 *
 * Usage:
 *   const { openSettings } = useSettings()
 *   <button onClick={openSettings}>Configure providers</button>
 *
 * AppShell side:
 *   useSettingsListener((open) => setSettingsOpen(open))
 */

import { useCallback, useEffect, useState } from 'react'

const OPEN_EVENT = 'brightcode:settings:open'
const CLOSE_EVENT = 'brightcode:settings:close'

function dispatch(name: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name))
}

export function useSettings() {
  const openSettings = useCallback(() => dispatch(OPEN_EVENT), [])
  const closeSettings = useCallback(() => dispatch(CLOSE_EVENT), [])
  return { openSettings, closeSettings }
}

/** Use this in the component that owns the Settings dialog state. */
export function useSettingsListener(
  onChange: (open: boolean) => void,
): boolean {
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    const open = () => {
      onChange(true)
      setIsOpen(true)
    }
    const close = () => {
      onChange(false)
      setIsOpen(false)
    }
    window.addEventListener(OPEN_EVENT, open)
    window.addEventListener(CLOSE_EVENT, close)
    return () => {
      window.removeEventListener(OPEN_EVENT, open)
      window.removeEventListener(CLOSE_EVENT, close)
    }
  }, [onChange])
  return isOpen
}
