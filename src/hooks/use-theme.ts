import { useEffect, useState } from 'react'

export type Theme =
  | 'dark'
  | 'light'
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

const POLITRON_DATA_THEMES = [
  'cafeine',
  'candyland',
  'claude',
  'dark-matter',
  'violet-bloom',
  'tangerine',
  't3chat',
  'cyberpunk',
  'terminal-muted',
  'omegon',
  'msn',
  'zen',
  'melancholik',
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
        root.removeAttribute('data-theme')
        root.classList.add(systemDark ? 'dark' : 'light')
      } else if (t === 'dark') {
        root.removeAttribute('data-theme')
        root.classList.add('dark')
      } else if (t === 'light') {
        root.removeAttribute('data-theme')
        root.classList.add('light')
      } else if (POLITRON_DATA_THEMES.includes(t)) {
        root.setAttribute('data-theme', t)
        root.classList.add('dark')
      } else {
        root.removeAttribute('data-theme')
        root.classList.add('dark', `theme-${t}`)
      }
    }

    applyTheme(theme)
    localStorage.setItem(STORAGE_KEY, theme)

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (e: MediaQueryListEvent) => {
        root.classList.remove(...ALL_THEME_CLASSES)
        root.removeAttribute('data-theme')
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
