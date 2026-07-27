/**
 * CreateAgentDialog — a tabbed modal for adding a new agent.
 *
 * The original layout was a single long form (name, description, system
 * prompt, model, working folder stacked vertically), which got very tall
 * on small windows. The redesign splits the *source* of the agent's
 * instructions from the *identity* of the agent:
 *
 *   Tab "Preset"   — pick one of the bundled starters in
 *                    `agents/presets/` (Backend, Frontend, ...). The
 *                    markdown is shown in the preview pane; selecting
 *                    a preset pre-fills the description + system prompt.
 *   Tab "From file"— browse for any `.md` on disk via the OS picker.
 *   Tab "Custom"   — write the system prompt yourself from scratch.
 *
 * The form (name, emoji, description, system prompt, model) is shared
 * across all three tabs. Picking a source only pre-fills the
 * description + system prompt; the user is always free to edit before
 * saving.
 */

import { useMemo, useState } from 'react'
import { ChevronDown, FileText, FolderOpen, Search } from 'lucide-react'
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { agentStore } from '@/lib/agents'
import { AGENT_PRESETS, type AgentPreset } from '@/lib/agents/presets'
import { useAvailableModelsGrouped, useDefaultModel } from '@/hooks/use-provider-registry'
import { cn } from '@/lib/utils'

const EMOJIS = ['🎨', '🛠️', '🧪', '📋', '🔧', '🚀', '🖥️', '🎯', '💡', '🔍', '🧠', '⚡']

const NAME_MAX = 20
const DESCRIPTION_MAX = 100
const PROMPT_MAX = 4000

const DEFAULT_TOOLS = ['read_file', 'write_file', 'search_files', 'edit_file']

type SourceTab = 'preset' | 'file' | 'custom'

function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <span className="text-muted-foreground/70 block pt-1 text-right text-[11px] tabular-nums">
      {value.length}/{max}
    </span>
  )
}

/**
 * Pull a short description from a markdown body. We use the first
 * non-heading paragraph as the prose, falling back to the first 140
 * characters of the body. This keeps the modal's description column
 * consistent with what's already inside the markdown instead of forcing
 * the user to retype it.
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
    // First prose paragraph after the title.
    return trimmed.slice(0, DESCRIPTION_MAX)
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX)
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

  const [tab, setTab] = useState<SourceTab>('preset')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    AGENT_PRESETS[0]?.id ?? null,
  )
  const [pickedFilePath, setPickedFilePath] = useState<string | null>(null)
  const [pickedFileError, setPickedFileError] = useState<string | null>(null)
  const [presetSearch, setPresetSearch] = useState('')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [emoji, setEmoji] = useState(EMOJIS[0])
  const [systemPrompt, setSystemPrompt] = useState('')
  const [selectedModel, setSelectedModel] = useState(defaultModelId)

  const [emojiOpen, setEmojiOpen] = useState(false)

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

  const selectedPreset: AgentPreset | undefined = useMemo(
    () => AGENT_PRESETS.find((p) => p.id === selectedPresetId),
    [selectedPresetId],
  )

  const filteredPresets = useMemo(() => {
    const q = presetSearch.trim().toLowerCase()
    if (!q) return AGENT_PRESETS
    return AGENT_PRESETS.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.content.toLowerCase().includes(q),
    )
  }, [presetSearch])

  function applyPreset(preset: AgentPreset) {
    setSelectedPresetId(preset.id)
    if (!name.trim()) {
      // Suggest a name from the preset filename. User can edit.
      setName(preset.name.replace(/\s+/g, '-').slice(0, NAME_MAX))
    }
    if (!description.trim()) {
      setDescription(extractDescriptionFromMarkdown(preset.content))
    }
    if (!systemPrompt.trim()) {
      setSystemPrompt(preset.content)
    }
  }

  async function pickFile() {
    setPickedFileError(null)
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
    if (!result.path) return // user cancelled
    setPickedFilePath(result.path)
    const readResult = await window.electronAPI?.skills?.read(result.path)
    if (!readResult || typeof readResult !== 'string') {
      setPickedFileError('Could not read the chosen file.')
      return
    }
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
    setTab('preset')
    setSelectedPresetId(AGENT_PRESETS[0]?.id ?? null)
    setPickedFilePath(null)
    setPickedFileError(null)
    setPresetSearch('')
    setName('')
    setDescription('')
    setEmoji(EMOJIS[0])
    setSystemPrompt('')
    setSelectedModel(defaultModelId)
  }

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    void agentStore.add({
      name: trimmed,
      emoji,
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      model: selectedModel,
      tools: DEFAULT_TOOLS,
      enabled: true,
    })
    onOpenChange(false)
    reset()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto p-0">
        <div className="flex items-center justify-between px-5 pt-4 pb-0">
          <DialogTitle>Create Agent</DialogTitle>
          <DialogCloseButton />
        </div>

        <div className="px-5 pb-5 pt-2">
          <Tabs value={tab} onValueChange={(v) => setTab(v as SourceTab)}>
            <TabsList>
              <TabsTrigger value="preset">Preset</TabsTrigger>
              <TabsTrigger value="file">From file</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>

            {/* ── Preset tab ─────────────────────────────────────────────── */}
            <TabsContent value="preset" className="pt-3">
              {AGENT_PRESETS.length === 0 ? (
                <p className="text-muted-foreground text-[12.5px]">
                  No presets bundled. Add a markdown file to{' '}
                  <code className="bg-muted rounded px-1">agents/presets/</code>{' '}
                  and rebuild.
                </p>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="relative">
                    <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
                    <Input
                      value={presetSearch}
                      onChange={(e) => setPresetSearch(e.target.value)}
                      placeholder="Search presets…"
                      className="bg-secondary/40 border-border/60 h-8 pl-8 text-[12.5px]"
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {filteredPresets.map((preset) => {
                      const active = preset.id === selectedPresetId
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => applyPreset(preset)}
                          className={cn(
                            'border-border/60 bg-card/40 hover:border-foreground/30 hover:bg-card/70 group rounded-lg border px-3 py-2.5 text-left transition-colors',
                            active && 'border-foreground/40 bg-card/80',
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <FileText className="text-muted-foreground size-3.5 shrink-0" />
                            <span className="text-foreground text-[12.5px] font-medium">
                              {preset.name}
                            </span>
                          </div>
                          <div className="text-muted-foreground mt-1 truncate text-[11.5px]">
                            {preset.fileName}
                          </div>
                        </button>
                      )
                    })}
                    {filteredPresets.length === 0 && (
                      <p className="text-muted-foreground col-span-full text-[12px]">
                        No presets match “{presetSearch}”.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </TabsContent>

            {/* ── From-file tab ──────────────────────────────────────────── */}
            <TabsContent value="file" className="pt-3">
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void pickFile()}
                  className="border-border/60 text-muted-foreground hover:bg-accent/40 flex h-9 items-center gap-2 rounded-md border px-3 text-[12.5px] transition-colors"
                >
                  <FolderOpen className="size-3.5" />
                  <span className="flex-1 truncate text-left">
                    {pickedFilePath ?? 'Browse for a .md file…'}
                  </span>
                </button>
                {pickedFileError && (
                  <p className="text-destructive text-[11.5px]">
                    {pickedFileError}
                  </p>
                )}
                <p className="text-muted-foreground/80 text-[11.5px]">
                  The chosen file is loaded into the system prompt below.
                  Edit anything before saving.
                </p>
              </div>
            </TabsContent>

            {/* ── Custom tab ─────────────────────────────────────────────── */}
            <TabsContent value="custom" className="pt-3">
              <p className="text-muted-foreground text-[12.5px]">
                Write the agent's instructions from scratch. The
                description and system prompt below are independent of
                any preset.
              </p>
            </TabsContent>
          </Tabs>

          {/* ── Shared form (always visible) ──────────────────────────── */}
          <div className="mt-4 flex flex-col gap-4 border-t pt-4">
            {/* Emoji + Name in a single row */}
            <div className="flex items-start gap-3">
              <div>
                <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
                  Icon
                </span>
                <div className="relative">
                  <button
                    type="button"
                    className="bg-secondary ring-border/60 hover:ring-ring/60 flex size-10 items-center justify-center rounded-full text-lg ring-1 transition-shadow"
                    onClick={() => setEmojiOpen((o) => !o)}
                    aria-label="Pick agent icon"
                  >
                    {emoji}
                  </button>
                  {emojiOpen && (
                    <div className="bg-popover ring-border/60 absolute top-12 left-0 z-50 grid w-52 grid-cols-4 gap-1 rounded-lg p-2 ring-1 shadow-lg">
                      {EMOJIS.map((e) => (
                        <button
                          key={e}
                          type="button"
                          className={cn(
                            'flex size-10 items-center justify-center rounded-lg text-lg transition-colors',
                            e === emoji
                              ? 'bg-primary/20 ring-primary/40 ring-1'
                              : 'hover:bg-accent',
                          )}
                          onClick={() => {
                            setEmoji(e)
                            setEmojiOpen(false)
                          }}
                        >
                          {e}
                        </button>
                      ))}
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

            {/* System prompt — compact textarea, shows source attribution */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="create-agent-system-prompt"
                  className="text-muted-foreground text-[12px] font-medium"
                >
                  System prompt
                </label>
                {tab === 'preset' && selectedPreset && (
                  <span className="text-muted-foreground/70 text-[11px]">
                    from <code>{selectedPreset.fileName}</code>
                  </span>
                )}
                {tab === 'file' && pickedFilePath && (
                  <span className="text-muted-foreground/70 truncate text-[11px]">
                    from{' '}
                    <code>{pickedFilePath.split(/[\\/]/).pop()}</code>
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
