import { useState } from 'react'
import { useTheme } from '@/hooks/use-theme'
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

const themes = [
  { id: 'light', label: 'Light Mode', icon: Sun },
  { id: 'dark', label: 'Dark Mode', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const

export type ThemeId = (typeof themes)[number]['id']

function ThemeMock({ variant }: { variant: 'light' | 'dark' }) {
  const light = variant === 'light'
  return (
    <div
      className={cn(
        'flex h-full flex-1 flex-col gap-1.5 p-2',
        light ? 'bg-white' : 'bg-zinc-900',
      )}
    >
      <div
        className={cn(
          'h-2 w-2/3 rounded-sm',
          light ? 'bg-zinc-300' : 'bg-zinc-700',
        )}
      />
      <div
        className={cn(
          'h-2 w-1/2 rounded-sm',
          light ? 'bg-zinc-200' : 'bg-zinc-800',
        )}
      />
      <div
        className={cn(
          'mt-auto h-4 w-full rounded-sm',
          light ? 'bg-zinc-200' : 'bg-zinc-800',
        )}
      />
    </div>
  )
}

function AppearanceTab() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Theme</SectionLabel>
      <div className="grid grid-cols-3 gap-4">
        {themes.map(({ id, label, icon: Icon }) => {
          const selected = theme === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTheme(id)}
              className="flex flex-col gap-2 text-left"
            >
              <span
                className={cn(
                  'border-border/60 flex h-24 overflow-hidden rounded-lg border transition-shadow',
                  selected && 'ring-primary ring-2',
                )}
              >
                {id === 'system' ? (
                  <>
                    <ThemeMock variant="light" />
                    <ThemeMock variant="dark" />
                  </>
                ) : (
                  <ThemeMock variant={id} />
                )}
              </span>
              <span className="flex items-center gap-1.5 text-[12px] font-medium">
                <Icon className="text-muted-foreground size-3.5" />
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Placeholder tabs                                                     */
/* ------------------------------------------------------------------ */

const placeholders: Record<string, { title: string; description: string }> = {
  account: {
    title: 'Account',
    description:
      'Manage your profile, subscription plan and connected devices.',
  },
  usage: {
    title: 'Usage & model',
    description:
      'Track token consumption and choose the default model for new tasks.',
  },
}

function PlaceholderTab({ id }: { id: string }) {
  const info = placeholders[id]
  return (
    <div>
      <p className="text-foreground text-[13px] font-medium">{info.title}</p>
      <p className="text-muted-foreground pt-1 text-[13px] leading-5">
        {info.description}
      </p>
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
      <DialogContent className="h-[70vh] max-w-3xl overflow-hidden p-0">
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
              ) : (
                <PlaceholderTab id={tab} />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
