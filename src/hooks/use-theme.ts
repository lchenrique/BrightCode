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

export type FontScale = 'xs' | 's' | 'm' | 'l' | 'xl'
export type Density = 'compact' | 'comfortable'

const STORAGE_MODE = 'brightcode:color-mode'
const STORAGE_PRESET = 'brightcode:theme-preset'
const STORAGE_FONT_SCALE = 'brightcode:font-scale'
const STORAGE_DENSITY = 'brightcode:density'
const STORAGE_WORD_WRAP = 'brightcode:editor-word-wrap'

function readStorage<T extends string>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  const v = localStorage.getItem(key) as T | null
  return v ?? fallback
}

export function useTheme() {
  const [colorMode, setColorModeState] = useState<ColorMode>(() =>
    readStorage(STORAGE_MODE, 'dark'),
  )

  const [themePreset, setThemePresetState] = useState<ThemePreset>(() =>
    readStorage(STORAGE_PRESET, 'default'),
  )

  const [fontScale, setFontScaleState] = useState<FontScale>(() =>
    readStorage(STORAGE_FONT_SCALE, 'm'),
  )

  const [density, setDensityState] = useState<Density>(() =>
    readStorage(STORAGE_DENSITY, 'comfortable'),
  )

  const [editorWordWrap, setEditorWordWrapState] = useState<boolean>(() =>
    (readStorage<string>(STORAGE_WORD_WRAP, 'false') as string) === 'true',
  )

  useEffect(() => {
    const root = document.documentElement

    // 1. Set data-theme for preset
    if (themePreset === 'default') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', themePreset)
    }

    // 2. Apply dark/light class
    const isDark =
      colorMode === 'dark' ||
      (colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    root.classList.toggle('dark', isDark)
    root.classList.toggle('light', !isDark)

    // 3. Apply font scale + density + word wrap via data attributes.
    //    index.css reads these and applies the actual CSS (zoom for size,
    //    --row-density CSS var, and wordWrap toggles monaco option).
    root.setAttribute('data-font-scale', fontScale)
    root.setAttribute('data-density', density)
    root.setAttribute('data-word-wrap', String(editorWordWrap))

    localStorage.setItem(STORAGE_MODE, colorMode)
    localStorage.setItem(STORAGE_PRESET, themePreset)
    localStorage.setItem(STORAGE_FONT_SCALE, fontScale)
    localStorage.setItem(STORAGE_DENSITY, density)
    localStorage.setItem(STORAGE_WORD_WRAP, String(editorWordWrap))

    if (colorMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (e: MediaQueryListEvent) => {
        root.classList.toggle('dark', e.matches)
        root.classList.toggle('light', !e.matches)
      }
      mediaQuery.addEventListener('change', listener)
      return () => mediaQuery.removeEventListener('change', listener)
    }
  }, [colorMode, themePreset, fontScale, density, editorWordWrap])

  const setColorMode = (mode: ColorMode) => setColorModeState(mode)
  const setThemePreset = (preset: ThemePreset) => setThemePresetState(preset)
  const setFontScale = (scale: FontScale) => setFontScaleState(scale)
  const setDensity = (d: Density) => setDensityState(d)
  const setEditorWordWrap = (wrap: boolean) => setEditorWordWrapState(wrap)

  return {
    colorMode,
    setColorMode,
    themePreset,
    setThemePreset,
    fontScale,
    setFontScale,
    density,
    setDensity,
    editorWordWrap,
    setEditorWordWrap,
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
