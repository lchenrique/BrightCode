import { useEffect, useState } from 'react'

export type Theme =
  | 'dark'
  | 'light'
  | 'catppuccin'
  | 'supabase'
  | 'amethyst'
  | 'cosmic'
  | 'tokyonight'
  | 'nordic'
  | 'solarized'
  | 'system'

const STORAGE_KEY = 'brightcode:theme'
const ALL_THEME_CLASSES = [
  'dark',
  'light',
  'theme-catppuccin',
  'theme-supabase',
  'theme-amethyst',
  'theme-cosmic',
  'theme-tokyonight',
  'theme-nordic',
  'theme-solarized',
]

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'dark'
    return (localStorage.getItem(STORAGE_KEY) as Theme) || 'dark'
  })

  useEffect(() => {
    const root = document.documentElement

    const applyTheme = (t: Theme) => {
      root.classList.remove(...ALL_THEME_CLASSES)

      if (t === 'system') {
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        root.classList.add(systemDark ? 'dark' : 'light')
      } else if (t === 'dark') {
        root.classList.add('dark')
      } else if (t === 'light') {
        root.classList.add('light')
      } else {
        root.classList.add('dark', `theme-${t}`)
      }
    }

    applyTheme(theme)
    localStorage.setItem(STORAGE_KEY, theme)

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (e: MediaQueryListEvent) => {
        root.classList.remove(...ALL_THEME_CLASSES)
        root.classList.add(e.matches ? 'dark' : 'light')
      }
      mediaQuery.addEventListener('change', listener)
      return () => mediaQuery.removeEventListener('change', listener)
    }
  }, [theme])

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme)
  }

  return { theme, setTheme }
}
