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

export type FontScale = number
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

function readNumber(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback
  const raw = localStorage.getItem(key)
  if (raw === null) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Bounds for the font-size slider. Stay in sync with the slider in
 *  SettingsDialog — the same constants drive the CSS `transform: scale()`
 *  range so the layout never overflows the viewport. */
export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 2
export const FONT_SCALE_STEP = 0.01
export const FONT_SCALE_DEFAULT = 1

/** Named checkpoints for the slider labels. Anything between two
 *  adjacent checkpoints falls under the smaller label. */
export const FONT_SCALE_TICKS: Array<{ value: number; label: string }> = [
  { value: 0.85, label: 'XS' },
  { value: 0.93, label: 'S' },
  { value: 1, label: 'M' },
  { value: 1.12, label: 'L' },
  { value: 1.25, label: 'XL' },
  { value: 1.4, label: '2XL' },
  { value: 1.6, label: '3XL' },
  { value: 1.85, label: '4XL' },
  { value: 2, label: '5XL' },
]

export function fontScaleLabel(value: number): string {
  let label = FONT_SCALE_TICKS[0]!.label
  for (const tick of FONT_SCALE_TICKS) {
    if (value >= tick.value - 1e-6) label = tick.label
  }
  return label
}

export function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return FONT_SCALE_DEFAULT
  const clamped = Math.min(
    FONT_SCALE_MAX,
    Math.max(FONT_SCALE_MIN, value),
  )
  // Round to the nearest step, then to 2 decimals to avoid float noise.
  return Math.round(clamped / FONT_SCALE_STEP) * FONT_SCALE_STEP
}

export function useTheme() {
  const [colorMode, setColorModeState] = useState<ColorMode>(() =>
    readStorage(STORAGE_MODE, 'dark'),
  )

  const [themePreset, setThemePresetState] = useState<ThemePreset>(() =>
    readStorage(STORAGE_PRESET, 'default'),
  )

  const [fontScale, setFontScaleState] = useState<FontScale>(() =>
    clampFontScale(readNumber(STORAGE_FONT_SCALE, FONT_SCALE_DEFAULT)),
  )

  const [density, setDensityState] = useState<Density>(() =>
    readStorage(STORAGE_DENSITY, 'comfortable'),
  )

  const [editorWordWrap, setEditorWordWrapState] = useState<boolean>(() =>
    (readStorage<string>(STORAGE_WORD_WRAP, 'false') as string) === 'true',
  )

  useEffect(() => {
    const html = document.documentElement
    const rootEl = document.getElementById('root') ?? html

    // 1. Set data-theme for preset
    if (themePreset === 'default') {
      html.removeAttribute('data-theme')
    } else {
      html.setAttribute('data-theme', themePreset)
    }

    // 2. Apply dark/light class
    const isDark =
      colorMode === 'dark' ||
      (colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

    html.classList.toggle('dark', isDark)
    html.classList.toggle('light', !isDark)

    // 3. Apply font scale + density + word wrap via CSS custom property
    //    on #root. The scale is a continuous number (0.85 → 2.0), and
    //    index.css reads `--font-scale` to drive `transform: scale()`
    //    + the inverse `width/height` so the layout box shrinks in the
    //    same proportion that the visual grows — nothing pinned to the
    //    bottom of the viewport (chat input, etc.) gets clipped.
    rootEl.style.setProperty('--font-scale', String(fontScale))
    html.setAttribute('data-density', density)
    html.setAttribute('data-word-wrap', String(editorWordWrap))

    localStorage.setItem(STORAGE_MODE, colorMode)
    localStorage.setItem(STORAGE_PRESET, themePreset)
    localStorage.setItem(STORAGE_FONT_SCALE, String(fontScale))
    localStorage.setItem(STORAGE_DENSITY, density)
    localStorage.setItem(STORAGE_WORD_WRAP, String(editorWordWrap))

    if (colorMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = (e: MediaQueryListEvent) => {
        html.classList.toggle('dark', e.matches)
        html.classList.toggle('light', !e.matches)
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
