import { useState } from 'react'
import { useTheme } from '@/hooks/use-theme'
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  FONT_SCALE_TICKS,
  fontScaleLabel,
} from '@/hooks/use-theme'
import {
  ChartBar,
  CircleUser,
  Code2,
  Globe,
  MessageSquare,
  Monitor,
  Moon,
  Sun,
  SunMoon,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { ProvidersSettings } from './ProvidersSettings'
import { UsageSettings } from './UsageSettings'
import { AccountSettings } from './AccountSettings'
import { cn } from '@/lib/utils'

/* ------------------------------------------------------------------ */
/* Nav                                                                  */
/* ------------------------------------------------------------------ */

const navItems = [
  { id: 'general', label: 'General', icon: Monitor },
  { id: 'connection', label: 'Connection', icon: Globe },
  { id: 'appearance', label: 'Appearance', icon: SunMoon },
  { id: 'account', label: 'Account', icon: CircleUser },
  { id: 'usage', label: 'Usage & model', icon: ChartBar },
] as const

type NavId = (typeof navItems)[number]['id']

/* ------------------------------------------------------------------ */
/* General tab                                                          */
/* ------------------------------------------------------------------ */

const modes = [
  {
    id: 'coding',
    title: 'For coding',
    description: 'More detail and dev tools',
    icon: Code2,
  },
  {
    id: 'everyday',
    title: 'For everyday work',
    description: 'Same power, simpler view',
    icon: MessageSquare,
  },
] as const

type ModeId = (typeof modes)[number]['id']

function ModeCard({
  mode,
  selected,
  onSelect,
}: {
  mode: (typeof modes)[number]
  selected: boolean
  onSelect: () => void
}) {
  const Icon = mode.icon
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex flex-1 flex-col gap-2 rounded-xl border p-4 text-left transition-colors',
        selected
          ? 'border-primary ring-primary/60 ring-1'
          : 'border-border/60 hover:bg-accent/40',
      )}
    >
      <div className="flex items-center justify-between">
        <Icon className="text-muted-foreground size-5" />
        <span
          className={cn(
            'flex size-4 items-center justify-center rounded-full border',
            selected ? 'border-primary' : 'border-muted-foreground/50',
          )}
        >
          {selected && <span className="bg-primary size-2 rounded-full" />}
        </span>
      </div>
      <div>
        <div className="text-[13px] font-medium">{mode.title}</div>
        <div className="text-muted-foreground text-[12px]">
          {mode.description}
        </div>
      </div>
    </button>
  )
}

const appSwitches = [
  {
    id: 'menubar',
    title: 'Show in Menu Bar',
    description: 'Show app icon in the menu bar / system tray',
  },
  {
    id: 'startup',
    title: 'Launch on Startup',
    description: 'Automatically start the app when you log in',
  },
  {
    id: 'notifications',
    title: 'Desktop Notifications',
    description:
      'Notify when tasks complete, errors occur, or permissions are needed',
  },
] as const

type SwitchId = (typeof appSwitches)[number]['id']

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-muted-foreground/70 text-[11px] font-normal tracking-wide uppercase">
      {children}
    </span>
  )
}

function GeneralTab() {
  const [mode, setMode] = useState<ModeId>('coding')
  const [switches, setSwitches] = useState<Record<SwitchId, boolean>>({
    menubar: true,
    startup: true,
    notifications: true,
  })

  return (
    <div className="flex flex-col gap-7">
      {/* Mode */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Mode</SectionLabel>
        <div className="flex gap-3" role="radiogroup" aria-label="Mode">
          {modes.map((m) => (
            <ModeCard
              key={m.id}
              mode={m}
              selected={mode === m.id}
              onSelect={() => setMode(m.id)}
            />
          ))}
        </div>
      </section>

      {/* Application */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Application</SectionLabel>
        <div className="flex flex-col gap-4">
          {appSwitches.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-6">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{s.title}</div>
                <div className="text-muted-foreground text-[12px] leading-5">
                  {s.description}
                </div>
              </div>
              <Switch
                checked={switches[s.id]}
                onCheckedChange={(v) =>
                  setSwitches((prev) => ({ ...prev, [s.id]: v }))
                }
                aria-label={s.title}
              />
            </div>
          ))}
        </div>
      </section>

      {/* Quick Input Shortcut */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Quick Input Shortcut</SectionLabel>
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">Show quick input</span>
          <div className="flex items-center gap-1.5">
            <kbd className="border-border/60 bg-secondary text-foreground/90 rounded-md border px-2 py-0.5 font-mono text-[12px]">
              Alt+A
            </kbd>
            <button
              type="button"
              aria-label="Clear shortcut"
              className="text-muted-foreground hover:text-foreground hover:bg-accent/50 inline-flex size-6 items-center justify-center rounded-md transition-colors"
              onClick={() => console.log('[settings] clear shortcut')}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Appearance tab                                                       */
/* ------------------------------------------------------------------ */

const colorModes = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const

const themePresets = [
  { id: 'default', label: 'BrightCode', bg: 'bg-[#18181b]', sidebar: 'bg-[#0f0f11]', accent: 'bg-amber-500' },
  { id: 'claude', label: 'Anthropic Claude', bg: 'bg-[#1d1b18]', sidebar: 'bg-[#171513]', accent: 'bg-amber-600' },
  { id: 'cyberpunk', label: 'Cyberpunk Neon', bg: 'bg-[#0d0f18]', sidebar: 'bg-[#080910]', accent: 'bg-pink-500' },
  { id: 'candyland', label: 'Candyland Pink', bg: 'bg-[#1f1924]', sidebar: 'bg-[#17121c]', accent: 'bg-pink-400' },
  { id: 'dark-matter', label: 'Dark Matter Mono', bg: 'bg-[#121212]', sidebar: 'bg-[#0a0a0a]', accent: 'bg-emerald-400' },
  { id: 'cafeine', label: 'Cafeine Coffee', bg: 'bg-[#faf6f0]', sidebar: 'bg-[#f2ece4]', accent: 'bg-amber-800' },
  { id: 'violet-bloom', label: 'Violet Bloom', bg: 'bg-[#1a1429]', sidebar: 'bg-[#130e20]', accent: 'bg-purple-400' },
  { id: 'tangerine', label: 'Tangerine Sunset', bg: 'bg-[#1f1410]', sidebar: 'bg-[#170e0a]', accent: 'bg-orange-500' },
  { id: 't3chat', label: 'T3 Chat', bg: 'bg-[#12141c]', sidebar: 'bg-[#0b0c12]', accent: 'bg-indigo-400' },
  { id: 'terminal-muted', label: 'Terminal Muted', bg: 'bg-[#141619]', sidebar: 'bg-[#0d0e10]', accent: 'bg-teal-400' },
  { id: 'msn', label: 'MSN Retro', bg: 'bg-[#e8f1f5]', sidebar: 'bg-[#d8e6ee]', accent: 'bg-blue-600' },
  { id: 'zen', label: 'Zen Minimalist', bg: 'bg-[#161616]', sidebar: 'bg-[#0e0e0e]', accent: 'bg-zinc-400' },
  { id: 'melancholik', label: 'Melancholik Slate', bg: 'bg-[#151922]', sidebar: 'bg-[#0d1017]', accent: 'bg-slate-400' },
  { id: 'catppuccin', label: 'Catppuccin Mocha', bg: 'bg-[#1e1e2e]', sidebar: 'bg-[#181825]', accent: 'bg-purple-400' },
  { id: 'supabase', label: 'Supabase Emerald', bg: 'bg-[#121212]', sidebar: 'bg-[#0c0c0c]', accent: 'bg-emerald-500' },
  { id: 'amethyst', label: 'Amethyst Haze', bg: 'bg-[#18122B]', sidebar: 'bg-[#110c20]', accent: 'bg-fuchsia-500' },
  { id: 'cosmic', label: 'Cosmic Night', bg: 'bg-[#0b132b]', sidebar: 'bg-[#070d20]', accent: 'bg-cyan-400' },
  { id: 'tokyonight', label: 'Tokyo Night', bg: 'bg-[#1a1b26]', sidebar: 'bg-[#16161e]', accent: 'bg-pink-500' },
  { id: 'nordic', label: 'Nordic Frost', bg: 'bg-[#1c2331]', sidebar: 'bg-[#161b26]', accent: 'bg-sky-400' },
  { id: 'solarized', label: 'Solarized Amber', bg: 'bg-[#073642]', sidebar: 'bg-[#002b36]', accent: 'bg-amber-400' },
] as const

export type ThemeId = (typeof themePresets)[number]['id']

function ThemeMockCard({
  bg,
  sidebar,
  accent,
  isLightMode,
}: {
  bg: string
  sidebar: string
  accent: string
  isLightMode: boolean
}) {
  return (
    <div
      className={cn(
        'relative flex h-16 w-full overflow-hidden rounded-xl border border-border/60 p-2 shadow-sm transition-all',
        isLightMode ? 'bg-white' : bg,
      )}
    >
      {/* Sidebar mini */}
      <div
        className={cn(
          'flex h-full w-6 flex-col gap-1 rounded-lg p-1',
          isLightMode ? 'bg-zinc-100' : sidebar,
        )}
      >
        <div
          className={cn(
            'h-1.5 w-full rounded',
            isLightMode ? 'bg-zinc-300' : 'bg-white/20',
          )}
        />
        <div
          className={cn(
            'h-1.5 w-3/4 rounded',
            isLightMode ? 'bg-zinc-200' : 'bg-white/10',
          )}
        />
      </div>
      {/* Content mini */}
      <div className="ml-2 flex flex-1 flex-col justify-between py-0.5">
        <div className="space-y-1">
          <div
            className={cn(
              'h-1.5 w-16 rounded',
              isLightMode ? 'bg-zinc-300' : 'bg-white/20',
            )}
          />
          <div
            className={cn(
              'h-1.5 w-24 rounded',
              isLightMode ? 'bg-zinc-200' : 'bg-white/10',
            )}
          />
        </div>
        <div className={cn('h-2 w-5 rounded-full', accent)} />
      </div>
    </div>
  )
}

const densities = [
  { id: 'compact', label: 'Compact', hint: 'Tighter rows, more content on screen.' },
  { id: 'comfortable', label: 'Comfortable', hint: 'Default spacing, easier to scan.' },
] as const

function AppearanceTab() {
  const {
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
  } = useTheme()

  return (
    <div className="flex flex-col gap-6">
      {/* Section 1: Color Mode (Light / Dark / System) */}
      <div className="flex flex-col gap-2.5">
        <SectionLabel>Appearance Mode</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          {colorModes.map(({ id, label, icon: Icon }) => {
            const selected = colorMode === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setColorMode(id)}
                className={cn(
                  'flex items-center justify-center gap-2 rounded-xl border py-2.5 px-3 text-xs font-medium transition-all cursor-pointer',
                  selected
                    ? 'border-primary bg-primary/10 text-primary font-semibold'
                    : 'border-border/60 hover:border-border text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Section 2: Text size (continuous slider; the layout box shrinks
          inversely to the visual scale so nothing gets clipped) */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <SectionLabel>Text size</SectionLabel>
          <div className="flex items-baseline gap-1.5">
            <span className="text-foreground text-[12px] font-semibold tabular-nums">
              {fontScale.toFixed(2)}x
            </span>
            <span className="text-muted-foreground text-[11px] font-medium">
              {fontScaleLabel(fontScale)}
            </span>
          </div>
        </div>
        <p className="text-muted-foreground text-[11.5px]">
          Scales every panel, button and label in the app. Drag for fine
          control — the layout box shrinks as the visual grows so nothing
          is clipped.
        </p>
        <div className="flex flex-col gap-2 pt-1">
          <input
            type="range"
            min={FONT_SCALE_MIN}
            max={FONT_SCALE_MAX}
            step={FONT_SCALE_STEP}
            value={fontScale}
            onChange={(event) => setFontScale(Number(event.target.value))}
            aria-label="Text size"
            className="brightcode-range w-full cursor-pointer"
            style={
              {
                '--range-progress':
                  (fontScale - FONT_SCALE_MIN) /
                  (FONT_SCALE_MAX - FONT_SCALE_MIN),
              } as React.CSSProperties
            }
          />
          {/* Tick row — labels at the named checkpoints. Highlights the
              active range so the user can see how far they've pushed past
              the default "M". */}
          <div className="relative h-4">
            {FONT_SCALE_TICKS.map((tick) => {
              const pct =
                ((tick.value - FONT_SCALE_MIN) /
                  (FONT_SCALE_MAX - FONT_SCALE_MIN)) *
                100
              const active = Math.abs(tick.value - fontScale) < 1e-6
              return (
                <button
                  key={tick.label}
                  type="button"
                  onClick={() => setFontScale(tick.value)}
                  title={`${tick.value.toFixed(2)}x`}
                  className="group absolute top-0 -translate-x-1/2 cursor-pointer"
                  style={{ left: `${pct}%` }}
                >
                  <span
                    className={cn(
                      'block h-1.5 w-px transition-colors',
                      active
                        ? 'bg-primary'
                        : 'bg-muted-foreground/30 group-hover:bg-muted-foreground/60',
                    )}
                  />
                  <span
                    className={cn(
                      'mt-0.5 block text-[9px] font-medium transition-colors',
                      active
                        ? 'text-primary'
                        : 'text-muted-foreground/60 group-hover:text-muted-foreground',
                    )}
                  >
                    {tick.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Section 3: UI density */}
      <div className="flex flex-col gap-2.5">
        <SectionLabel>UI density</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          {densities.map(({ id, label, hint }) => {
            const selected = density === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setDensity(id)}
                aria-pressed={selected}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-all cursor-pointer',
                  selected
                    ? 'border-primary bg-primary/10'
                    : 'border-border/60 hover:border-border',
                )}
              >
                <span
                  className={cn(
                    'text-xs font-semibold',
                    selected ? 'text-primary' : 'text-foreground/90',
                  )}
                >
                  {label}
                </span>
                <span className="text-muted-foreground text-[11px] leading-tight">
                  {hint}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Section 4: Editor — word wrap */}
      <div className="flex flex-col gap-2.5">
        <SectionLabel>Editor</SectionLabel>
        <div className="border-border/60 flex items-center justify-between rounded-lg border px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-foreground/90 text-xs font-medium">
              Word wrap in code editor
            </span>
            <span className="text-muted-foreground text-[11px]">
              Long lines wrap instead of scrolling horizontally.
            </span>
          </div>
          <Switch
            checked={editorWordWrap}
            onCheckedChange={setEditorWordWrap}
            aria-label="Toggle word wrap in code editor"
          />
        </div>
      </div>

      {/* Section 5: Theme Presets & Styles */}
      <div className="flex flex-col gap-2.5">
        <SectionLabel>Theme Style & Palette</SectionLabel>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {themePresets.map(({ id, label, bg, sidebar, accent }) => {
            const selected = themePreset === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => setThemePreset(id as any)}
                className="group flex flex-col gap-1.5 text-left cursor-pointer"
              >
                <div
                  className={cn(
                    'w-full overflow-hidden rounded-xl border border-border/60 transition-all group-hover:border-border',
                    selected
                      ? 'ring-primary ring-2 border-transparent'
                      : 'opacity-85 hover:opacity-100',
                  )}
                >
                  <ThemeMockCard
                    bg={bg}
                    sidebar={sidebar}
                    accent={accent}
                    isLightMode={colorMode === 'light'}
                  />
                </div>
                <span
                  className={cn(
                    'text-[12px] font-medium transition-colors',
                    selected ? 'text-primary font-semibold' : 'text-foreground/80',
                  )}
                >
                  {label}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tab, setTab] = useState<NavId>('general')

  const activeNav: { label: string; icon: LucideIcon } =
    navItems.find((n) => n.id === tab) ?? navItems[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl overflow-hidden p-0"
        style={{ height: '70vh' }}
      >
        <div className="flex h-full">
          {/* Left nav */}
          <nav className="border-border/60 flex w-48 shrink-0 flex-col gap-0.5 border-r px-2 py-4">
            <span className="text-muted-foreground/70 px-2 pb-2 text-[11px] font-normal tracking-wide uppercase">
              Settings
            </span>
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                  tab === id
                    ? 'bg-accent text-foreground'
                    : 'text-foreground/80 hover:bg-accent/50',
                )}
              >
                <Icon className="text-muted-foreground size-4" />
                {label}
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between px-6 pt-5">
              <DialogTitle>{activeNav.label}</DialogTitle>
              <DialogCloseButton />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {tab === 'general' ? (
                <GeneralTab />
              ) : tab === 'appearance' ? (
                <AppearanceTab />
              ) : tab === 'connection' ? (
                <ProvidersSettings />
              ) : tab === 'usage' ? (
                <UsageSettings />
              ) : tab === 'account' ? (
                <AccountSettings />
              ) : null}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
