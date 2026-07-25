import { useEffect, useState } from 'react'

export type ColorMode = 'light' | 'dark' | 'system'

export type ThemePreset =
  | 'default'
  | 'claude'
  | 'cyberpunk'
  | 'candyland'
  | 'dark-matter'
  | 'cafeine'
  | 'violet-bloom'
  | 'tangerine'
  | 't3chat'
  | 'terminal-muted'
  | 'omegon'
  | 'msn'
  | 'zen'
  | 'melancholik'
  | 'catppuccin'
  | 'supabase'
  | 'amethyst'
  | 'cosmic'
  | 'tokyonight'
  | 'nordic'
  | 'solarized'

const STORAGE_MODE = 'brightcode:color-mode'
const STORAGE_PRESET = 'brightcode:theme-preset'

export function useTheme() {
  const [colorMode, setColorModeState] = useState<ColorMode>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem(STORAGE_MODE) as ColorMode) || 'dark'
  })

  const [themePreset, setThemePresetState] = useState<ThemePreset>(() => {
    if (typeof window === 'undefined') return 'default'
    return (localStorage.getItem(STORAGE_PRESET) as ThemePreset) || 'default'
  })

  useEffect(() => {
    const root = document.documentElement

    const applyTheme = (mode: ColorMode, preset: ThemePreset) => {
      // 1. Set data-theme for preset
      if (preset === 'default') {
        root.removeAttribute('data-theme')
      } else {
        root.setAttribute('data-theme', preset)
      }

      // 2. Apply dark/light class
      const isDark =
        mode === 'dark' ||
        (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

      if (isDark) {
        root.classList.add('dark')
        root.classList.remove('light')
      } else {
        root.classList.remove('dark')
        root.classList.add('light')
      }
    }

    applyTheme(colorMode, themePreset)

    localStorage.setItem(STORAGE_MODE, colorMode)
    localStorage.setItem(STORAGE_PRESET, themePreset)

    if (colorMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (e: MediaQueryListEvent) => {
        if (e.matches) {
          root.classList.add('dark')
          root.classList.remove('light')
        } else {
          root.classList.remove('dark')
          root.classList.add('light')
        }
      }
      mediaQuery.addEventListener('change', listener)
      return () => mediaQuery.removeEventListener('change', listener)
    }
  }, [colorMode, themePreset])

  const setColorMode = (mode: ColorMode) => setColorModeState(mode)
  const setThemePreset = (preset: ThemePreset) => setThemePresetState(preset)

  return {
    colorMode,
    setColorMode,
    themePreset,
    setThemePreset,
    theme: themePreset,
    setTheme: (val: any) => {
      if (val === 'light' || val === 'dark' || val === 'system') {
        setColorModeState(val)
      } else {
        setThemePresetState(val)
      }
    },
  }
}
