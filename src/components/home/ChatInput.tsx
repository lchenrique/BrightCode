import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { Plus, RefreshCw, Brain, ChevronDown, ArrowUp, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ModelInfo } from '@/lib/providers'
import { cn } from '@/lib/utils'

export interface ModelOption {
  providerId: string
  modelId: string
  label: string
}

/**
 * Group of models from a single provider. Used by the new grouped picker
 * (preferred) — the registry's `listAvailableModelsGrouped()` already
 * returns this shape.
 */
export interface ModelGroup {
  providerId: string
  providerName: string
  hasCredential: boolean
  models: ModelInfo[]
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high'

export interface ChatInputProps {
  onSend?: (text: string) => void | Promise<void>
  disabled?: boolean
  thinking?: boolean
  onThinkingChange?: (v: boolean) => void
  thinkingLevel?: ThinkingLevel
  onThinkingLevelChange?: (v: ThinkingLevel) => void
  authMode?: 'full' | 'read'
  onAuthModeChange?: (v: 'full' | 'read') => void
  /**
   * Grouped model picker (preferred). When provided, supersedes `modelOptions`.
   * Each group becomes a labeled section in the dropdown, with a free-model
   * badge where applicable.
   */
  modelGroups?: ModelGroup[]
  /** @deprecated use `modelGroups` for grouped display. */
  modelOptions?: ModelOption[]
  selectedModel?: string // e.g. "openai/gpt-5"
  onModelChange?: (v: string) => void
  placeholder?: string
  emptyModelMessage?: string
  /**
   * When true, the textarea is auto-focused on mount. Used by the
   * welcome screen so the user can start typing immediately after
   * clicking "New task" without an extra click.
   */
  autoFocus?: boolean
}

const DEFAULT_MODEL_GROUPS: ModelGroup[] = []

export function ChatInput({
  onSend,
  disabled,
  thinking: thinkingProp,
  onThinkingChange,
  thinkingLevel: thinkingLevelProp,
  onThinkingLevelChange,
  authMode: authModeProp,
  onAuthModeChange,
  modelGroups = DEFAULT_MODEL_GROUPS,
  modelOptions,
  selectedModel,
  onModelChange,
  placeholder = 'Enter message... (use / for commands)',
  emptyModelMessage = 'Add a provider in Settings',
  autoFocus = false,
}: ChatInputProps) {
  // Uncontrolled fallback for the props that callers might not wire up
  const [internalThinkingLevel, setInternalThinkingLevel] = useState<ThinkingLevel>('medium')
  const [internalAuth, setInternalAuth] = useState<'full' | 'read'>('full')
  const [internalModel, setInternalModel] = useState<string>(() => {
    if (selectedModel) return selectedModel
    if (modelGroups.length > 0) {
      const first = modelGroups[0].models[0]
      if (first) return `${first.provider}/${first.id}`
    }
    if (modelOptions && modelOptions.length > 0) {
      return `${modelOptions[0].providerId}/${modelOptions[0].modelId}`
    }
    return ''
  })

  const level = thinkingLevelProp ?? (thinkingProp === false ? 'off' : internalThinkingLevel)
  const authMode = authModeProp ?? internalAuth
  const model = selectedModel ?? internalModel

  const setThinkingLevel = (v: ThinkingLevel) => {
    if (onThinkingLevelChange) onThinkingLevelChange(v)
    else setInternalThinkingLevel(v)

    const isEnabled = v !== 'off'
    if (onThinkingChange) onThinkingChange(isEnabled)
  }

  const setAuthMode = (v: 'full' | 'read') =>
    onAuthModeChange ? onAuthModeChange(v) : setInternalAuth(v)
  const setModel = (v: string) => (onModelChange ? onModelChange(v) : setInternalModel(v))
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // When the caller switches from `modelOptions` to `modelGroups` (or the
  // groups change shape), make sure the current selection still resolves.
  useEffect(() => {
    if (!model) {
      const first = modelGroups[0]?.models[0]
      if (first) setModel(`${first.provider}/${first.id}`)
      return
    }
    if (modelGroups.length > 0) {
      const found = modelGroups.some((g) =>
        g.models.some((m) => `${m.provider}/${m.id}` === model),
      )
      if (!found) {
        const first = modelGroups[0].models[0]
        if (first) setModel(`${first.provider}/${first.id}`)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelGroups])

  // Auto-grow textarea
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    if (!model) return
    setValue('')
    if (onSend) void onSend(text)
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="bg-card ring-border/40 w-full rounded-2xl px-4 py-3 shadow-2xl shadow-black/40 ring-1">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="placeholder:text-muted-foreground/70 text-foreground w-full resize-none border-0 bg-transparent text-[14px] leading-6 outline-none disabled:opacity-60"
      />

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Attach"
            disabled={disabled}
          >
            <Plus className="size-4" />
          </Button>

          <button
            type="button"
            onClick={() => setAuthMode(authMode === 'full' ? 'read' : 'full')}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors"
          >
            <RefreshCw className="size-3.5" />
            <span>
              {authMode === 'full' ? 'Full Authorization' : 'Read Only'}
            </span>
            <ChevronDown className="size-3.5 opacity-70" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <ThinkingSelector value={level} onChange={setThinkingLevel} />

          <span className="bg-border/60 h-4 w-px" />

          <ModelSelector
            value={model}
            onChange={setModel}
            groups={modelGroups}
            options={modelOptions}
            emptyMessage={emptyModelMessage}
          />

          <Button
            type="button"
            onClick={submit}
            disabled={!value.trim() || !model || disabled}
            size="icon-sm"
            className="bg-foreground text-background hover:bg-foreground/90 ml-1 size-7 rounded-md disabled:opacity-40"
            aria-label="Send"
          >
            <ArrowUp className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function ModelSelector({
  value,
  onChange,
  groups,
  options,
  emptyMessage,
}: {
  value: string
  onChange: (v: string) => void
  groups: ModelGroup[]
  options?: ModelOption[]
  emptyMessage: string
}) {
  const [open, setOpen] = useState(false)

  // Resolve the current selection to a display label.
  const currentLabel = (() => {
    if (!value) return null
    for (const g of groups) {
      const m = g.models.find((mm) => `${mm.provider}/${mm.id}` === value)
      if (m) return m.displayName
    }
    if (options) {
      const o = options.find(
        (oo) => `${oo.providerId}/${oo.modelId}` === value,
      )
      if (o) return o.label
    }
    return value
  })()

  // Backwards-compat: when caller passes the old `options` prop, flatten it
  // into a single synthetic group so the rest of the UI is consistent.
  const effectiveGroups: ModelGroup[] =
    groups.length > 0
      ? groups
      : options
        ? [
            {
              providerId: 'flat',
              providerName: 'Models',
              hasCredential: true,
              models: options.map((o) => ({
                id: o.modelId,
                displayName: o.label,
                provider: o.providerId,
              })),
            },
          ]
        : []

  const hasAny = effectiveGroups.some((g) => g.models.length > 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select model"
          className="text-foreground/90 hover:text-foreground inline-flex max-w-[200px] items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium transition-colors"
        >
          <span className="truncate">{currentLabel ?? emptyMessage}</span>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-96 p-1.5"
      >
        {!hasAny ? (
          <div className="text-muted-foreground px-2 py-3 text-center text-[12px]">
            {emptyMessage}
          </div>
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            {effectiveGroups.map((g) => (
              <div key={g.providerId} className="py-1">
                <div className="text-muted-foreground/80 flex items-center justify-between px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
                  <span className="truncate">{g.providerName}</span>
                  {!g.hasCredential && (
                    <span className="text-muted-foreground/60 ml-2 inline-flex items-center gap-1 text-[10px] font-normal normal-case">
                      <Sparkles className="size-2.5" /> free
                    </span>
                  )}
                </div>
                <div className="flex flex-col">
                  {g.models.map((m) => {
                    const fullId = `${m.provider}/${m.id}`
                    const selected = fullId === value
                    return (
                      <button
                        key={fullId}
                        type="button"
                        onClick={() => {
                          onChange(fullId)
                          setOpen(false)
                        }}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
                          selected
                            ? 'bg-accent text-foreground'
                            : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                        {m.free && (
                          <span className="text-muted-foreground bg-secondary/60 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                            free
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const THINKING_LEVELS: Array<{
  level: ThinkingLevel
  label: string
  desc: string
}> = [
  { level: 'off', label: 'Off', desc: 'No internal reasoning turn' },
  { level: 'minimal', label: 'Minimal', desc: 'Shortest reasoning trace' },
  { level: 'low', label: 'Low', desc: 'Fast, lightweight thinking' },
  { level: 'medium', label: 'Medium', desc: 'Balanced reasoning (default)' },
  { level: 'high', label: 'High', desc: 'Deep, thorough thinking' },
]

function ThinkingSelector({
  value,
  onChange,
}: {
  value: ThinkingLevel
  onChange: (level: ThinkingLevel) => void
}) {
  const [open, setOpen] = useState(false)
  const isEnabled = value !== 'off'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Thinking level"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors',
            isEnabled
              ? 'text-foreground hover:text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Brain className="size-3.5" />
          <span>Thinking</span>
          {isEnabled && <span className="bg-sky-400 ml-0.5 h-1.5 w-1.5 rounded-full" />}
          <ChevronDown className="text-muted-foreground size-3.5 opacity-70" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-56 p-1.5">
        <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
          Thinking intensity
        </div>
        <div className="flex flex-col gap-0.5">
          {THINKING_LEVELS.map((item) => {
            const selected = item.level === value
            return (
              <button
                key={item.level}
                type="button"
                onClick={() => {
                  onChange(item.level)
                  setOpen(false)
                }}
                className={cn(
                  'flex flex-col items-start rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                  selected
                    ? 'bg-accent text-foreground font-medium'
                    : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <span>{item.label}</span>
                <span className="text-muted-foreground text-[10.5px] font-normal">
                  {item.desc}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
