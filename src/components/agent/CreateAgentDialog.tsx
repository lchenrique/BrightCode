/**
 * CreateAgentDialog — a compact modal for adding a new agent.
 *
 * Source picker is a single dropdown that lists every bundled preset
 * (`agents/presets/`) plus a `Custom` option and a `Browse…` shortcut
 * to seed the system prompt from any markdown file on disk. The
 * modal is now flat (no tabs) and the form below it is shared across
 * all sources.
 *
 * Flow:
 *   1. User picks a preset → the system prompt (and optionally the
 *      description + name) pre-fills.
 *   2. User picks `Custom` → all fields start blank.
 *   3. User picks `Browse…` → OS file picker; the chosen file's
 *      content goes into the system prompt.
 *   4. The form is always editable, so the user can tweak a preset
 *      before saving.
 *
 * The Create button is disabled until both `name` and `systemPrompt`
 * are non-empty.
 */

import { useMemo, useState } from 'react'
import {
  ChevronDown,
  FileText,
  FolderOpen,
  Search,
  Shuffle,
  X,
} from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  AgentAvatar,
  AVATAR_PICKER_SEEDS,
  avatarSvg,
} from '@/components/ui/agent-avatar'
import { agentStore } from '@/lib/agents'
import { AGENT_PRESETS, type AgentPreset } from '@/lib/agents/presets'
import { useAvailableModelsGrouped, useDefaultModel } from '@/hooks/use-provider-registry'
import { cn } from '@/lib/utils'

const NAME_MAX = 20
const DESCRIPTION_MAX = 100
const PROMPT_MAX = 4000

function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <span className="text-muted-foreground/70 block pt-1 text-right text-[11px] tabular-nums">
      {value.length}/{max}
    </span>
  )
}

/**
 * Pull a short description from a markdown body. First non-heading,
 * non-list, non-empty line wins (capped at DESCRIPTION_MAX chars). This
 * keeps the modal's description column consistent with what's
 * already inside the markdown instead of forcing the user to retype.
 */
function extractDescriptionFromMarkdown(content: string): string {
  const lines = content.split(/\r?\n/)
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    if (trimmed.startsWith('- ')) continue
    return trimmed.slice(0, DESCRIPTION_MAX)
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX)
}

interface SourceSelection {
  /** One of `CUSTOM_VALUE`, `BROWSE_VALUE`, or a preset id. */
  kind: 'preset' | 'custom' | 'browse'
  presetId?: string
  filePath?: string
}

export function CreateAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const grouped = useAvailableModelsGrouped()
  const defaultModel = useDefaultModel()

  const defaultModelId = defaultModel
    ? `${defaultModel.provider}/${defaultModel.id}`
    : ''

  const [source, setSource] = useState<SourceSelection>({ kind: 'preset' })
  const [pickedFileError, setPickedFileError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSearch, setPickerSearch] = useState('')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatarSeed, setAvatarSeed] = useState(AVATAR_PICKER_SEEDS[0])
  const [systemPrompt, setSystemPrompt] = useState('')
  const [selectedModel, setSelectedModel] = useState(defaultModelId)

  const [avatarOpen, setAvatarOpen] = useState(false)

  const allModels = useMemo(
    () =>
      grouped.flatMap((g) =>
        g.models.map((m) => `${m.provider}/${m.id}`),
      ),
    [grouped],
  )

  const selectedModelLabel = useMemo(() => {
    for (const g of grouped) {
      const m = g.models.find((mm) => `${mm.provider}/${mm.id}` === selectedModel)
      if (m) return `${g.provider.name} / ${m.displayName}`
    }
    return selectedModel || 'Select model'
  }, [grouped, selectedModel])

  const selectedPreset: AgentPreset | undefined = useMemo(() => {
    if (source.kind !== 'preset' || !source.presetId) return undefined
    return AGENT_PRESETS.find((p) => p.id === source.presetId)
  }, [source])

  const filteredPresets = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase()
    if (!q) return AGENT_PRESETS
    return AGENT_PRESETS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q),
    )
  }, [pickerSearch])

  function applyPreset(preset: AgentPreset) {
    setSource({ kind: 'preset', presetId: preset.id })
    if (!name.trim()) {
      setName(preset.name.replace(/\s+/g, '-').slice(0, NAME_MAX))
    }
    if (!description.trim()) {
      setDescription(extractDescriptionFromMarkdown(preset.content))
    }
    if (!systemPrompt.trim()) {
      setSystemPrompt(preset.content)
    }
    if (preset.avatarSeed) {
      setAvatarSeed(preset.avatarSeed)
    }
    setPickerOpen(false)
    setPickerSearch('')
  }

  function applyCustom() {
    setSource({ kind: 'custom' })
    setPickerOpen(false)
    setPickerSearch('')
  }

  async function pickFile() {
    setPickedFileError(null)
    setPickerOpen(false)
    const api = window.electronAPI?.fs
    if (!api) {
      setPickedFileError('File picker is not available outside Electron.')
      return
    }
    const result = await api.browseFile({
      title: 'Pick an agent markdown file',
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (!result.ok) {
      setPickedFileError(result.error)
      return
    }
    if (!result.path) return
    const readResult = await window.electronAPI?.skills?.read(result.path)
    if (!readResult || typeof readResult !== 'string') {
      setPickedFileError('Could not read the chosen file.')
      return
    }
    setSource({ kind: 'browse', filePath: result.path })
    if (!name.trim()) {
      const fileName = result.path.split(/[\\/]/).pop() ?? 'agent'
      setName(fileName.replace(/\.(md|markdown|mdx|txt)$/i, '').slice(0, NAME_MAX))
    }
    if (!description.trim()) {
      setDescription(extractDescriptionFromMarkdown(readResult))
    }
    if (!systemPrompt.trim()) {
      setSystemPrompt(readResult)
    }
  }

  function reset() {
    setSource({ kind: 'preset' })
    setPickedFileError(null)
    setPickerOpen(false)
    setPickerSearch('')
    setName('')
    setDescription('')
    setAvatarSeed(AVATAR_PICKER_SEEDS[0])
    setSystemPrompt('')
    setSelectedModel(defaultModelId)
  }

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    const tools = selectedPreset
      ? selectedPreset.tools
      : ['read_file', 'write_file', 'search_files', 'edit_file']
    void agentStore.add({
      name: trimmed,
      avatarSeed,
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      model: selectedModel,
      tools,
      enabled: true,
    })
    onOpenChange(false)
    reset()
  }

  const triggerLabel =
    source.kind === 'preset' && selectedPreset
      ? selectedPreset.name
      : source.kind === 'browse'
        ? source.filePath?.split(/[\\/]/).pop() ?? 'From file…'
        : 'Custom — start from scratch'
  const triggerSubLabel =
    source.kind === 'preset' && selectedPreset
      ? selectedPreset.fileName
      : source.kind === 'browse'
        ? 'Markdown file from disk'
        : 'No preset — write the prompt yourself'

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto p-0">
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <DialogTitle>Create Agent</DialogTitle>
          <DialogCloseButton />
        </div>

        <div className="px-5 pb-5 pt-4">
          {/* ── Source dropdown ──────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[12px] font-medium">
              Source
            </span>
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Pick agent source"
                  className="border-border/60 bg-secondary/40 hover:bg-accent/40 flex h-10 w-full items-center gap-2 rounded-md border px-3 text-left transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground/90 block truncate text-[13px] font-medium">
                      {triggerLabel}
                    </span>
                    <span className="text-muted-foreground/80 block truncate text-[11.5px]">
                      {triggerSubLabel}
                    </span>
                  </span>
                  <ChevronDown className="text-muted-foreground size-4 shrink-0 opacity-70" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={4}
                className="bg-popover ring-border/60 w-[--radix-popover-trigger-width] rounded-md p-0 ring-1"
              >
                <div className="border-border/40 flex items-center gap-2 border-b px-3 py-2">
                  <Search className="text-muted-foreground size-3.5" />
                  <input
                    value={pickerSearch}
                    onChange={(e) => setPickerSearch(e.target.value)}
                    placeholder="Search presets…"
                    className="placeholder:text-muted-foreground/70 w-full bg-transparent text-[12.5px] outline-none"
                  />
                  {pickerSearch && (
                    <button
                      type="button"
                      onClick={() => setPickerSearch('')}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Clear search"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto py-1">
                  {/* Custom + Browse as static rows at the top */}
                  <button
                    type="button"
                    onClick={applyCustom}
                    className="hover:bg-accent flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] transition-colors"
                  >
                    <FileText className="text-muted-foreground size-3.5" />
                    <span className="flex-1">
                      <span className="text-foreground/90 block font-medium">
                        Custom
                      </span>
                      <span className="text-muted-foreground/80 block text-[11.5px]">
                        Start from scratch — no preset
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void pickFile()}
                    className="hover:bg-accent flex w-full items-center gap-2 border-border/40 border-t px-3 py-2 text-left text-[12.5px] transition-colors"
                  >
                    <FolderOpen className="text-muted-foreground size-3.5" />
                    <span className="flex-1">
                      <span className="text-foreground/90 block font-medium">
                        Browse…
                      </span>
                      <span className="text-muted-foreground/80 block text-[11.5px]">
                        Pick a markdown file from disk
                      </span>
                    </span>
                  </button>

                  {filteredPresets.length > 0 && (
                    <div className="border-border/40 border-t pt-1">
                      {filteredPresets.map((preset) => {
                        const active = source.kind === 'preset' && source.presetId === preset.id
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => applyPreset(preset)}
                            className={cn(
                              'hover:bg-accent flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors',
                              active && 'bg-accent',
                            )}
                          >
                            <AgentAvatar
                              seed={preset.avatarSeed ?? preset.id}
                              size={18}
                              className="ring-0"
                            />
                            <span className="flex-1">
                              <span className="text-foreground/90 block font-medium">
                                {preset.name}
                              </span>
                              <span className="text-muted-foreground/80 block text-[11.5px]">
                                {preset.fileName}
                              </span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {filteredPresets.length === 0 && (
                    <p className="text-muted-foreground px-3 py-2 text-[12px]">
                      No presets match “{pickerSearch}”.
                    </p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {pickedFileError && (
              <p className="text-destructive text-[11.5px]">
                {pickedFileError}
              </p>
            )}
          </div>

          {/* ── Shared form (always visible) ──────────────────────────── */}
          <div className="mt-4 flex flex-col gap-4 border-t pt-4">
            {/* Avatar + Name in a single row */}
            <div className="flex items-start gap-3">
              <div>
                <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
                  Avatar
                </span>
                <div className="relative">
                  <button
                    type="button"
                    className="ring-border/60 hover:ring-ring/60 flex size-10 items-center justify-center overflow-hidden rounded-full bg-secondary ring-1 transition-shadow"
                    onClick={() => setAvatarOpen((o) => !o)}
                    aria-label="Pick agent avatar"
                  >
                    <span
                      className="block size-10"
                      dangerouslySetInnerHTML={{ __html: avatarSvg(avatarSeed, 40) }}
                    />
                  </button>
                  {avatarOpen && (
                    <div className="bg-popover ring-border/60 absolute top-12 left-0 z-50 w-60 rounded-lg p-2 ring-1 shadow-lg">
                      <div className="mb-2 flex items-center justify-between px-1">
                        <span className="text-muted-foreground text-[11px] font-medium">
                          Pick an avatar
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const next =
                              AVATAR_PICKER_SEEDS[
                                Math.floor(Math.random() * AVATAR_PICKER_SEEDS.length)
                              ]
                            setAvatarSeed(next)
                          }}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
                          aria-label="Shuffle avatar"
                        >
                          <Shuffle className="size-3" />
                          Shuffle
                        </button>
                      </div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {AVATAR_PICKER_SEEDS.map((seed) => (
                          <button
                            key={seed}
                            type="button"
                            className={cn(
                              'flex size-12 items-center justify-center overflow-hidden rounded-md ring-1 transition-colors',
                              seed === avatarSeed
                                ? 'bg-primary/20 ring-primary/60'
                                : 'ring-border/40 hover:bg-accent',
                            )}
                            onClick={() => {
                              setAvatarSeed(seed)
                              setAvatarOpen(false)
                            }}
                            aria-label={`Use avatar ${seed}`}
                          >
                            <span
                              className="block size-12"
                              dangerouslySetInnerHTML={{ __html: avatarSvg(seed, 48) }}
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-1">
                <label
                  htmlFor="create-agent-name"
                  className="text-muted-foreground mb-2 block text-[12px] font-medium"
                >
                  Name <span className="text-destructive">*</span>
                </label>
                <Input
                  id="create-agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                  placeholder="e.g. Backend-Node"
                  className="bg-secondary/40 border-border/60 h-9 text-[13px]"
                />
                <CharCount value={name} max={NAME_MAX} />
              </div>
            </div>

            {/* Description */}
            <div>
              <label
                htmlFor="create-agent-description"
                className="text-muted-foreground mb-2 block text-[12px] font-medium"
              >
                Description
              </label>
              <Input
                id="create-agent-description"
                value={description}
                onChange={(e) =>
                  setDescription(e.target.value.slice(0, DESCRIPTION_MAX))
                }
                placeholder="What does this agent do?"
                className="bg-secondary/40 border-border/60 h-9 text-[13px]"
              />
              <CharCount value={description} max={DESCRIPTION_MAX} />
            </div>

            {/* System prompt — capped, scrollable, source attribution */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="create-agent-system-prompt"
                  className="text-muted-foreground text-[12px] font-medium"
                >
                  System prompt
                </label>
                {source.kind === 'preset' && selectedPreset && (
                  <span className="text-muted-foreground/70 text-[11px]">
                    from <code>{selectedPreset.fileName}</code>
                  </span>
                )}
                {source.kind === 'browse' && source.filePath && (
                  <span className="text-muted-foreground/70 truncate text-[11px]">
                    from{' '}
                    <code>{source.filePath.split(/[\\/]/).pop()}</code>
                  </span>
                )}
              </div>
              <Textarea
                id="create-agent-system-prompt"
                value={systemPrompt}
                onChange={(e) =>
                  setSystemPrompt(e.target.value.slice(0, PROMPT_MAX))
                }
                placeholder="You are a React frontend specialist..."
                className="bg-secondary/40 border-border/60 min-h-32 max-h-72 resize-y text-[12.5px] leading-relaxed font-mono"
              />
              <CharCount value={systemPrompt} max={PROMPT_MAX} />
              {selectedPreset && (
                <p className="text-muted-foreground/70 mt-1 text-[11.5px]">
                  Tools allowed for this preset:{' '}
                  <code>{selectedPreset.tools.join(', ')}</code>
                </p>
              )}
            </div>

            {/* Model selector */}
            <div>
              <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
                Model
              </span>
              <button
                type="button"
                className="border-border/60 text-muted-foreground hover:bg-accent/40 flex h-9 w-full items-center gap-2 rounded-md border px-3 text-[13px] transition-colors"
                onClick={() => {
                  const idx = allModels.indexOf(selectedModel)
                  const next = (idx + 1) % allModels.length
                  setSelectedModel(allModels[next] ?? selectedModel)
                }}
              >
                <span className="flex-1 truncate text-left">
                  {selectedModelLabel}
                </span>
                <ChevronDown className="size-4 shrink-0 opacity-70" />
              </button>
            </div>
          </div>
        </div>

        <div className="border-border/40 bg-muted/30 flex justify-end gap-2 border-t px-5 py-3">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="text-[13px]">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={!name.trim() || !systemPrompt.trim()}
            onClick={handleCreate}
            className="bg-primary text-primary-foreground hover:bg-primary/90 text-[13px] disabled:opacity-40"
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
