import { useState, useRef, useEffect, type KeyboardEvent } from 'react'
import { RefreshCw, Brain, ChevronDown, ChevronLeft, ArrowUp, Sparkles, Search, Check, User, UserCheck, Square, X, Plus, FileCode, Bot, PlusCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { ModelInfo } from '@/lib/providers'
import { providerRegistry } from '@/lib/providers'
import { useAgents } from '@/hooks/use-agents'
import { useActiveProjectId } from '@/hooks/use-projects'
import { cn } from '@/lib/utils'

// Slash command definitions
interface SlashCommand {
  id: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  insertText: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'read-file', label: 'Read file', description: 'Read and display file contents', icon: FileCode, insertText: '/read ' },
  { id: 'search', label: 'Search', description: 'Search for text in files', icon: Search, insertText: '/search ' },
  { id: 'new-file', label: 'New file', description: 'Create a new file', icon: PlusCircle, insertText: '/new ' },
  { id: 'agent', label: 'Delegate to agent', description: 'Ask another agent for help', icon: Bot, insertText: '/delegate ' },
]

// Placeholder files shown in the @ mention menu when the caller does not
// pass a real list. Once the workspace fs lands in the renderer, callers
// can wire the project's actual files here.
const DEFAULT_MENTION_FILES = [
  'src/index.tsx',
  'src/App.tsx',
  'src/components/Button.tsx',
]

export interface AttachedImage {
  /** Stable id used for the preview key. */
  id: string
  /** Base64-encoded image data (no data: prefix). */
  data: string
  /** MIME type, e.g. "image/png". */
  mediaType: string
  /** Original file name (for the user-visible label). */
  name: string
  /** Size in bytes — used to enforce the per-message budget. */
  size: number
}

export interface SubmitPayload {
  text: string
  images: AttachedImage[]
}

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
  onSend?: (payload: SubmitPayload) => void | Promise<void>
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
  selectedAccountId?: string
  onAccountChange?: (accountId: string | undefined) => void
  placeholder?: string
  emptyModelMessage?: string
  /**
   * When true, the textarea is auto-focused on mount. Used by the
   * welcome screen so the user can start typing immediately after
   * clicking "New task" without an extra click.
   */
  autoFocus?: boolean
  isStreaming?: boolean
  onStop?: () => void
  /**
   * Called whenever the textarea's non-empty status changes (true on
   * first non-blank character, false when cleared). The parent can use
   * it to drive UI that wants to react to "is the user composing a
   * message on this task right now?". Debounced by the ChatInput so
   * the parent doesn't get a callback per keystroke.
   */
  onTypingChange?: (typing: boolean) => void
  /**
   * Whether the currently selected model supports image input. When
   * false, the attach button is hidden so users don't queue images
   * the model can't see.
   */
  supportsImages?: boolean
  /**
   * Optional override for the file list suggested by the @ mention menu.
   * When omitted, falls back to a small placeholder list so the menu
   * is never empty.
   */
  mentionFiles?: string[]
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8MB per image
const MAX_IMAGES_PER_MESSAGE = 4

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
  selectedAccountId,
  onAccountChange,
  placeholder = 'Enter message... (use / for commands)',
  emptyModelMessage = 'Add a provider in Settings',
  autoFocus = false,
  isStreaming,
  onStop,
  onTypingChange,
  supportsImages = true,
  mentionFiles: mentionFilesProp,
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
  const [authDropdownOpen, setAuthDropdownOpen] = useState(false)

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
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [imageError, setImageError] = useState<string | null>(null)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashMenuQuery, setSlashMenuQuery] = useState('')
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false)
  const [mentionMenuQuery, setMentionMenuQuery] = useState('')
  // Mention menu data sources. Real agents come from agentStore so the
  // user can mention an agent by name. Files are still placeholder until
  // the workspace fs lands in the renderer; we keep a small fallback so
  // the menu never looks empty.
  const agents = useAgents()
  // Project files for the @ mention menu. We fetch the workspace tree
  // when the menu opens so the picker stays snappy until the user
  // actually needs it. The active project id drives the lookup; falls
  // back to DEFAULT_MENTION_FILES when no project is active.
  const activeProjectId = useActiveProjectId()
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>(DEFAULT_MENTION_FILES)
  useEffect(() => {
    if (!mentionMenuOpen) return
    if (!activeProjectId || typeof window === 'undefined' || !window.electronAPI?.workspace) {
      setWorkspaceFiles(DEFAULT_MENTION_FILES)
      return
    }
    let active = true
    void window.electronAPI.workspace.listTree(activeProjectId).then((res) => {
      if (!active) return
      if (!res || !('ok' in res) || !res.ok) {
        setWorkspaceFiles(DEFAULT_MENTION_FILES)
        return
      }
      const flat: string[] = []
      const walk = (entries: Array<{ name: string; path: string; isDir: boolean }>) => {
        for (const entry of entries) {
          if (!entry.isDir) flat.push(entry.path)
        }
      }
      walk(res.entries)
      setWorkspaceFiles(flat.length > 0 ? flat : DEFAULT_MENTION_FILES)
    })
    return () => {
      active = false
    }
  }, [mentionMenuOpen, activeProjectId])
  const mentionFiles = mentionFilesProp ?? workspaceFiles
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Reset the transient image error after a few seconds so the input
  // doesn't stay stuck with a red helper line forever.
  useEffect(() => {
    if (!imageError) return
    const t = setTimeout(() => setImageError(null), 4_000)
    return () => clearTimeout(t)
  }, [imageError])

  function pickFiles() {
    fileInputRef.current?.click()
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    setImageError(null)
    const next: AttachedImage[] = []
    let err: string | null = null
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      if (!file) continue
      if (!file.type.startsWith('image/')) {
        err = `Skipped non-image file: ${file.name}`
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        err = `${file.name} is too large (max 8MB)`
        continue
      }
      if (attachedImages.length + next.length >= MAX_IMAGES_PER_MESSAGE) {
        err = `At most ${MAX_IMAGES_PER_MESSAGE} images per message`
        break
      }
      try {
        const data = await readFileAsBase64(file)
        next.push({
          id: `img_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
          data,
          mediaType: file.type,
          name: file.name,
          size: file.size,
        })
      } catch (e) {
        err = `Failed to read ${file.name}: ${(e as Error).message}`
      }
    }
    if (next.length > 0) {
      setAttachedImages((prev) => [...prev, ...next])
    }
    if (err) setImageError(err)
  }

  function removeImage(id: string) {
    setAttachedImages((prev) => {
      const next = prev.filter((img) => img.id !== id)
      if (next.length === 0 && !value.trim()) onTypingChange?.(false)
      return next
    })
  }

  const submit = () => {
    const text = value.trim()
    if ((!text && attachedImages.length === 0) || disabled) return
    if (!model) return
    setValue('')
    const images = attachedImages
    setAttachedImages([])
    if (onSend) void onSend({ text, images })
  }

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  // Handle slash commands and @ mentions in the textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value
    const cursorPos = e.target.selectionStart ?? 0
    const textBeforeCursor = newValue.slice(0, cursorPos)

    // Check for slash command trigger
    const lastSlashIndex = textBeforeCursor.lastIndexOf('/')
    const lastAtIndex = textBeforeCursor.lastIndexOf('@')
    const lastNewlineIndex = textBeforeCursor.lastIndexOf('\n')

    // Determine context: is the slash/at on the current line?
    const slashOnCurrentLine = lastSlashIndex > lastNewlineIndex
    const atOnCurrentLine = lastAtIndex > lastNewlineIndex

    // Check if slash command is active (no space between slash and cursor)
    if (slashOnCurrentLine && lastSlashIndex >= 0) {
      const textAfterSlash = textBeforeCursor.slice(lastSlashIndex + 1)
      const hasSpaceAfter = textAfterSlash.includes(' ')
      if (!hasSpaceAfter && textAfterSlash.length > 0) {
        setSlashMenuOpen(true)
        setSlashMenuQuery(textAfterSlash)
      } else if (hasSpaceAfter) {
        setSlashMenuOpen(false)
      }
    } else {
      setSlashMenuOpen(false)
    }

    // Check for @ mention trigger
    if (atOnCurrentLine && lastAtIndex >= 0) {
      const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1)
      const hasSpaceAfter = textAfterAt.includes(' ')
      if (!hasSpaceAfter && textAfterAt.length > 0) {
        setMentionMenuOpen(true)
        setMentionMenuQuery(textAfterAt)
      } else if (hasSpaceAfter) {
        setMentionMenuOpen(false)
      }
    } else {
      setMentionMenuOpen(false)
    }

    setValue(newValue)
    onTypingChange?.(newValue.length > 0)
  }

  return (
    <div
      data-chat-composer
      className="bg-card ring-border/40 w-full rounded-2xl px-4 py-3 shadow-2xl shadow-black/40 ring-1"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files)
          // Reset so the same file can be picked again later.
          e.target.value = ''
        }}
      />

      {attachedImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachedImages.map((img) => (
            <div
              key={img.id}
              className="bg-muted/40 border-border/60 group relative size-16 overflow-hidden rounded-md border"
            >
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.name}
                className="size-full object-cover"
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="bg-background/80 text-foreground/80 hover:text-foreground absolute top-0.5 right-0.5 inline-flex size-5 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                aria-label={`Remove ${img.name}`}
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Slash command menu */}
      {slashMenuOpen && (
        <div className="mb-2 rounded-lg border border-border/60 bg-popover p-1.5 shadow-md">
          <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
            Commands
          </div>
          <div className="max-h-48 overflow-y-auto">
            {SLASH_COMMANDS.filter(
              (cmd) =>
                cmd.label.toLowerCase().includes(slashMenuQuery.toLowerCase()) ||
                cmd.id.includes(slashMenuQuery.toLowerCase()),
            ).map((cmd) => {
              const Icon = cmd.icon
              return (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => {
                    // Insert the command at the current cursor position
                    const cursorPos = taRef.current?.selectionStart ?? 0
                    const textBefore = value.slice(0, cursorPos)
                    const textAfter = value.slice(cursorPos)
                    const lastSlash = textBefore.lastIndexOf('/')
                    const newTextBefore = textBefore.slice(0, lastSlash) + cmd.insertText
                    setValue(newTextBefore + textAfter)
                    setSlashMenuOpen(false)
                    setSlashMenuQuery('')
                    // Move cursor to end of inserted text
                    setTimeout(() => {
                      if (taRef.current) {
                        const pos = newTextBefore.length
                        taRef.current.setSelectionRange(pos, pos)
                        taRef.current.focus()
                      }
                    }, 0)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                >
                  <Icon className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{cmd.label}</div>
                    <div className="text-muted-foreground truncate text-[10.5px]">{cmd.description}</div>
                  </div>
                </button>
              )
            })}
            {SLASH_COMMANDS.filter(
              (cmd) =>
                cmd.label.toLowerCase().includes(slashMenuQuery.toLowerCase()) ||
                cmd.id.includes(slashMenuQuery.toLowerCase()),
            ).length === 0 && (
              <div className="text-muted-foreground px-2 py-3 text-center text-[11px]">
                No commands found
              </div>
            )}
          </div>
        </div>
      )}

      {/* @ mention menu */}
      {mentionMenuOpen && (
        <div className="mb-2 rounded-lg border border-border/60 bg-popover p-1.5 shadow-md">
          <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
            Reference
          </div>
          <div className="max-h-48 overflow-y-auto">
            {/* File items (caller-provided or placeholder). */}
            {mentionFiles
              .filter((f) => f.toLowerCase().includes(mentionMenuQuery.toLowerCase()))
              .map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => {
                    const cursorPos = taRef.current?.selectionStart ?? 0
                    const textBefore = value.slice(0, cursorPos)
                    const textAfter = value.slice(cursorPos)
                    const lastAt = textBefore.lastIndexOf('@')
                    const newTextBefore = textBefore.slice(0, lastAt) + `@${file} `
                    setValue(newTextBefore + textAfter)
                    setMentionMenuOpen(false)
                    setMentionMenuQuery('')
                    setTimeout(() => {
                      if (taRef.current) {
                        const pos = newTextBefore.length
                        taRef.current.setSelectionRange(pos, pos)
                        taRef.current.focus()
                      }
                    }, 0)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                >
                  <FileCode className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{file}</div>
                    <div className="text-muted-foreground truncate text-[10.5px]">File</div>
                  </div>
                </button>
              ))}
            {/* Real agent items from agentStore. */}
            {agents
              .filter((a) => a.name.toLowerCase().includes(mentionMenuQuery.toLowerCase()))
              .map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    const cursorPos = taRef.current?.selectionStart ?? 0
                    const textBefore = value.slice(0, cursorPos)
                    const textAfter = value.slice(cursorPos)
                    const lastAt = textBefore.lastIndexOf('@')
                    const newTextBefore = textBefore.slice(0, lastAt) + `@${agent.name} `
                    setValue(newTextBefore + textAfter)
                    setMentionMenuOpen(false)
                    setMentionMenuQuery('')
                    setTimeout(() => {
                      if (taRef.current) {
                        const pos = newTextBefore.length
                        taRef.current.setSelectionRange(pos, pos)
                        taRef.current.focus()
                      }
                    }, 0)
                  }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent"
                >
                  <Bot className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{agent.name}</div>
                    <div className="text-muted-foreground truncate text-[10.5px]">Agent</div>
                  </div>
                </button>
              ))}
            {(() => {
              const filteredFiles = mentionFiles.filter((f) =>
                f.toLowerCase().includes(mentionMenuQuery.toLowerCase()),
              )
              const filteredAgents = agents.filter((a) =>
                a.name.toLowerCase().includes(mentionMenuQuery.toLowerCase()),
              )
              return filteredFiles.length === 0 && filteredAgents.length === 0 && mentionMenuQuery.length > 0 ? (
                <div className="text-muted-foreground px-2 py-3 text-center text-[11px]">
                  No results found
                </div>
              ) : null
            })()}
          </div>
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        onChange={handleTextareaChange}
        onKeyDown={handleKey}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="placeholder:text-muted-foreground/70 text-foreground w-full resize-none border-0 bg-transparent text-[14px] leading-6 outline-none disabled:opacity-60"
      />

      {imageError && (
        <div className="text-destructive mt-1 text-[11px]">{imageError}</div>
      )}

      {isStreaming && value.trim() && (
        <div className="text-muted-foreground mt-1 text-[11px]">
          Press Enter to queue after current response
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-y-2 gap-x-1">
        <div className="flex flex-wrap items-center gap-1">
          {supportsImages && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={pickFiles}
              className="text-muted-foreground hover:text-foreground shrink-0"
              aria-label="Attach image"
              disabled={disabled}
            >
              <Plus className="size-4" />
            </Button>
          )}

          <Popover open={authDropdownOpen} onOpenChange={setAuthDropdownOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1 text-[12px] font-medium transition-colors"
              >
                <RefreshCw className="size-3.5 shrink-0" />
                <span className="whitespace-nowrap">
                  {authMode === 'full' ? 'Full Authorization' : 'Read Only'}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-70" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" side="top" sideOffset={4} className="w-48 p-1.5">
              <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
                Authorization
              </div>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('full')
                    setAuthDropdownOpen(false)
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                    authMode === 'full'
                      ? 'bg-accent text-foreground font-medium'
                      : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  {authMode === 'full' ? <Check className="size-3.5 shrink-0" /> : <div className="size-3.5 shrink-0" />}
                  <div>
                    <div className="font-medium">Full Authorization</div>
                    <div className="text-muted-foreground text-[10.5px] font-normal">
                      Agent can read and write files, run commands
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('read')
                    setAuthDropdownOpen(false)
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                    authMode === 'read'
                      ? 'bg-accent text-foreground font-medium'
                      : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  {authMode === 'read' ? <Check className="size-3.5 shrink-0" /> : <div className="size-3.5 shrink-0" />}
                  <div>
                    <div className="font-medium">Read Only</div>
                    <div className="text-muted-foreground text-[10.5px] font-normal">
                      Agent can read files but cannot modify anything
                    </div>
                  </div>
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <ThinkingSelector value={level} onChange={setThinkingLevel} />

          <span className="bg-border/60 h-4 w-px shrink-0" />

          <ModelSelector
            value={model}
            onChange={setModel}
            groups={modelGroups}
            options={modelOptions}
            emptyMessage={emptyModelMessage}
          />

          <AccountSelector
            model={model}
            groups={modelGroups}
            selectedAccountId={selectedAccountId}
            onChange={onAccountChange}
          />

          {isStreaming ? (
            <Button
              type="button"
              onClick={onStop}
              size="icon-sm"
              className="bg-red-500 text-white hover:bg-red-600 ml-0.5 size-7 shrink-0 rounded-full"
              aria-label="Stop"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              onClick={submit}
              disabled={(!value.trim() && attachedImages.length === 0) || !model || disabled}
              size="icon-sm"
              className="bg-foreground text-background hover:bg-foreground/90 ml-0.5 size-7 shrink-0 rounded-full disabled:opacity-40"
              aria-label="Send"
            >
              <ArrowUp className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('Expected a data URL string'))
        return
      }
      // data URL: "data:image/png;base64,XXXX" → keep just the base64 part
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

interface ModelSelectorProps {
  value: string
  onChange: (v: string) => void
  groups: ModelGroup[]
  options?: ModelOption[]
  emptyMessage: string
}

type PickerStep = 'provider' | 'model'
type ProviderStatus = 'connected' | 'free' | 'unconfigured'

/** Provider step ordering: connected first, then free tier, then unconfigured. */
const PROVIDER_STATUS_RANK: Record<ProviderStatus, number> = {
  connected: 0,
  free: 1,
  unconfigured: 2,
}

function providerStatus(g: ModelGroup): ProviderStatus {
  if (g.hasCredential) return 'connected'
  return g.models.some((m) => m.free || m.requiresAuth === false)
    ? 'free'
    : 'unconfigured'
}

/** 200000 → "200K", 1000000 → "1M". */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

/** 3 → "$3", 0.8 → "$0.8" (per-1M-token pricing). */
function formatPrice(per1M: number): string {
  return `$${parseFloat(per1M.toFixed(2))}`
}

/** Secondary line under a model row, e.g. "200K · $3/$15" (parts omitted when unknown). */
function modelMetaLine(m: ModelInfo): string | null {
  const parts: string[] = []
  if (m.contextWindow) parts.push(formatContextWindow(m.contextWindow))
  const { inputCost, outputCost } = m
  if (inputCost != null && outputCost != null && (inputCost > 0 || outputCost > 0)) {
    parts.push(`${formatPrice(inputCost)}/${formatPrice(outputCost)}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function ModelSelector({ value, onChange, groups, options, emptyMessage }: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<PickerStep>('provider')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const contentRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

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

  // Provider step data: only providers with callable models — connected
  // (has credential) or offering at least one free/no-auth model. Empty
  // groups and unconfigured providers are hidden entirely. Order:
  // connected → free.
  const sortedGroups = effectiveGroups
    .filter((g) => g.models.length > 0 && providerStatus(g) !== 'unconfigured')
    .sort(
      (a, b) =>
        PROVIDER_STATUS_RANK[providerStatus(a)] - PROVIDER_STATUS_RANK[providerStatus(b)],
    )

  const hasAny = sortedGroups.length > 0

  // Model step data: the chosen provider's models, narrowed by the search box.
  const selectedGroup = selectedProviderId
    ? sortedGroups.find((g) => g.providerId === selectedProviderId)
    : undefined
  const query = searchQuery.trim().toLowerCase()
  const filteredModels = (selectedGroup?.models ?? []).filter((m) => {
    // When provider has no credential, only surface free/no-auth models.
    // This is a UI-level safety net on top of the registry filter.
    if (selectedGroup && !selectedGroup.hasCredential) {
      if (!m.free && m.requiresAuth !== false) return false
    }
    return query === '' || m.displayName.toLowerCase().includes(query)
  })

  const itemCount =
    step === 'model' && selectedGroup ? filteredModels.length : sortedGroups.length

  const scrollItemIntoView = (index: number) => {
    const items = contentRef.current?.querySelectorAll('[data-picker-item]')
    items?.[index]?.scrollIntoView({ block: 'nearest' })
  }

  const selectProvider = (providerId: string) => {
    setSelectedProviderId(providerId)
    setStep('model')
    setSearchQuery('')
    setFocusedIndex(-1)
  }

  const goBackToProviders = () => {
    setStep('provider')
    setSearchQuery('')
    setFocusedIndex(-1)
  }

  const selectModel = (m: ModelInfo) => {
    onChange(`${m.provider}/${m.id}`)
    setOpen(false)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) return
    // Always open at the provider list so the user sees every configured
    // provider at a glance, not just the last-used one's models.
    setSearchQuery('')
    setSelectedProviderId(null)
    setStep('provider')
    setFocusedIndex(-1)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (itemCount === 0) return
      const delta = e.key === 'ArrowDown' ? 1 : -1
      const next =
        focusedIndex < 0
          ? delta === 1
            ? 0
            : itemCount - 1
          : (focusedIndex + delta + itemCount) % itemCount
      setFocusedIndex(next)
      scrollItemIntoView(next)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const index = focusedIndex >= 0 ? focusedIndex : 0
      if (step === 'model' && selectedGroup) {
        const m = filteredModels[index]
        if (m) selectModel(m)
      } else {
        const g = sortedGroups[index]
        if (g) selectProvider(g.providerId)
      }
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
    // Escape is handled via onEscapeKeyDown so the model step can go back
    // to the provider step instead of closing outright.
  }

  // Move focus into the search field whenever the model step shows.
  useEffect(() => {
    if (open && step === 'model') searchRef.current?.focus()
  }, [open, step, selectedProviderId])

  // On open, scroll the focused (currently selected) model into view once
  // the popover content has mounted.
  useEffect(() => {
    if (open && step === 'model' && focusedIndex >= 0) scrollItemIntoView(focusedIndex)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select model"
          className="text-foreground/90 hover:text-foreground inline-flex max-w-[100px] xs:max-w-[140px] sm:max-w-[200px] items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium transition-colors"
        >
          <span className="truncate">{currentLabel ?? emptyMessage}</span>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        ref={contentRef}
        align="end"
        side="bottom"
        sideOffset={8}
        avoidCollisions
        collisionPadding={8}
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(event) => {
          // Provider step: default focus on the content (keyboard nav).
          // Model step: send focus straight to the search field.
          if (step === 'model') {
            event.preventDefault()
            searchRef.current?.focus()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (step === 'model') {
            event.preventDefault()
            goBackToProviders()
          }
        }}
        className="w-64 p-0 max-w-[calc(100vw-2rem)]"
      >
        {!hasAny ? (
          <div className="text-muted-foreground px-2 py-3 text-center text-[12px]">
            {emptyMessage}
          </div>
        ) : step === 'model' && selectedGroup ? (
          <div>
            <div className="border-border/60 flex items-center gap-1 border-b py-1 pr-2 pl-1">
              <button
                type="button"
                onClick={goBackToProviders}
                aria-label="Back to providers"
                className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-foreground/90 truncate text-[12px] font-medium">
                {selectedGroup.providerName}
              </span>
              <span className="text-muted-foreground/60 ml-auto shrink-0 text-[10.5px]">
                {filteredModels.length === selectedGroup.models.length
                  ? `${selectedGroup.models.length}`
                  : `${filteredModels.length}/${selectedGroup.models.length}`}
              </span>
            </div>

            <div className="border-border/60 flex items-center gap-2 border-b px-3">
              <Search className="text-muted-foreground/70 size-3.5 shrink-0" />
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setFocusedIndex(-1)
                }}
                placeholder="Search models..."
                aria-label="Search models"
                className="placeholder:text-muted-foreground/60 text-foreground h-8 w-full bg-transparent text-[12.5px] outline-none"
              />
            </div>

            <div className="max-h-[min(28rem,65dvh)] overflow-y-auto p-1">
              {filteredModels.length === 0 ? (
                <div className="text-muted-foreground px-2 py-3 text-center text-[12px]">
                  No models match &ldquo;{searchQuery.trim()}&rdquo;
                </div>
              ) : (
                filteredModels.map((m, i) => {
                  const fullId = `${m.provider}/${m.id}`
                  const selected = fullId === value
                  const meta = modelMetaLine(m)
                  return (
                    <button
                      key={fullId}
                      type="button"
                      data-picker-item
                      onClick={() => selectModel(m)}
                      onMouseEnter={() => setFocusedIndex(i)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left transition-colors',
                        i === focusedIndex ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-[12.5px]',
                            selected
                              ? 'text-foreground font-medium'
                              : 'text-foreground/90',
                          )}
                        >
                          {m.displayName}
                        </span>
                        {meta && (
                          <span className="text-muted-foreground block truncate text-[10.5px]">
                            {meta}
                          </span>
                        )}
                      </span>
                      {m.free && (
                        <span className="text-muted-foreground bg-secondary/60 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium">
                          free
                        </span>
                      )}
                      {selected && (
                        <Check className="text-muted-foreground size-3.5 shrink-0" />
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        ) : (
          <div className="max-h-[min(28rem,65dvh)] overflow-y-auto p-1">
            {sortedGroups.map((g, i) => {
              const status = providerStatus(g)
              return (
                <button
                  key={g.providerId}
                  type="button"
                  data-picker-item
                  onClick={() => selectProvider(g.providerId)}
                  onMouseEnter={() => setFocusedIndex(i)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors',
                    i === focusedIndex ? 'bg-accent' : 'hover:bg-accent',
                  )}
                >
                  <span className="flex size-3 shrink-0 items-center justify-center">
                    {status === 'connected' && (
                      <span className="size-1.5 rounded-full bg-emerald-400" />
                    )}
                    {status === 'free' && <Sparkles className="text-sky-400 size-3" />}
                    {status === 'unconfigured' && (
                      <span className="border-muted-foreground/50 size-1.5 rounded-full border" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground/90 block truncate text-[12.5px]">
                      {g.providerName}
                    </span>
                    <span className="text-muted-foreground block text-[10.5px]">
                      {g.models.length} model{g.models.length === 1 ? '' : 's'}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function AccountSelector({
  model,
  groups,
  selectedAccountId,
  onChange,
}: {
  model: string
  groups: ModelGroup[]
  selectedAccountId?: string
  onChange?: (accountId: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)

  const providerId = model.includes('/') ? model.split('/')[0]! : ''
  const group = groups.find((g) => g.providerId === providerId)
  if (!group || !group.hasCredential) return null

  const accounts = providerRegistry.listAccounts(providerId)
  if (accounts.length <= 1) return null

  const activeAccountId = selectedAccountId ?? providerRegistry.getActiveAccount(providerId)?.id
  const activeAccount = accounts.find((a) => a.id === activeAccountId)
  const activeLabel = activeAccount?.label ?? activeAccount?.email ?? 'Default'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select account"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium transition-colors"
        >
          <User className="size-3" />
          <span className="max-w-[80px] truncate">{activeLabel}</span>
          <ChevronDown className="text-muted-foreground size-3 shrink-0" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-48 p-1.5">
        <div className="text-muted-foreground/80 px-2 py-1 text-[10.5px] font-medium tracking-wide uppercase">
          Account
        </div>
        <div className="flex flex-col">
          {accounts.map((acc) => {
            const selected = acc.id === activeAccountId
            return (
              <button
                key={acc.id}
                type="button"
                onClick={() => {
                  onChange?.(acc.id === providerRegistry.getActiveAccount(providerId)?.id ? undefined : acc.id)
                  setOpen(false)
                }}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                  selected
                    ? 'bg-accent text-foreground'
                    : 'text-foreground/85 hover:bg-accent/60 hover:text-foreground',
                )}
              >
                {selected ? <UserCheck className="size-3.5 shrink-0" /> : <User className="size-3.5 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{acc.label || acc.email || 'Default'}</div>
                  {acc.email && acc.label && (
                    <div className="text-muted-foreground truncate text-[10px]">{acc.email}</div>
                  )}
                </div>
                {acc.id === providerRegistry.getActiveAccount(providerId)?.id && !selectedAccountId && (
                  <span className="text-muted-foreground shrink-0 text-[10px]">active</span>
                )}
              </button>
            )
          })}
        </div>
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

      <PopoverContent align="end" side="top" sideOffset={8} avoidCollisions collisionPadding={12} className="w-56 p-1.5">
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
