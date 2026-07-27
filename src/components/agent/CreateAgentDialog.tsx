import { useState, useMemo } from 'react'
import { ChevronDown, Folder } from 'lucide-react'
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
import { agentStore } from '@/lib/agents'
import { useAvailableModelsGrouped, useDefaultModel } from '@/hooks/use-provider-registry'

const EMOJIS = ['🎨', '🛠️', '🧪', '📋', '🔧', '🚀', '🖥️', '🎯', '💡', '🔍', '🧠', '⚡']

const NAME_MAX = 20
const DESCRIPTION_MAX = 100
const PROMPT_MAX = 500

const DEFAULT_TOOLS = ['read_file', 'write_file', 'search_files', 'edit_file']

function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <span className="text-muted-foreground/70 block pt-1 text-right text-[11px] tabular-nums">
      {value.length}/{max}
    </span>
  )
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

  const reset = () => {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5">
        <div className="flex items-center justify-between">
          <DialogTitle>Create Agent</DialogTitle>
          <DialogCloseButton />
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {/* Emoji picker */}
          <div>
            <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
              Icon
            </span>
            <div className="relative">
              <button
                type="button"
                className="bg-secondary ring-border/60 hover:ring-ring/60 flex size-14 items-center justify-center rounded-full text-xl ring-1 transition-shadow"
                onClick={() => setEmojiOpen((o) => !o)}
                aria-label="Pick agent icon"
              >
                {emoji}
              </button>
              {emojiOpen && (
                <div className="bg-popover ring-border/60 absolute top-16 left-0 z-50 grid w-56 grid-cols-4 gap-1 rounded-lg p-2 ring-1 shadow-lg">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className={`flex size-11 items-center justify-center rounded-lg text-xl transition-colors ${
                        e === emoji
                          ? 'bg-primary/20 ring-primary/40 ring-1'
                          : 'hover:bg-accent'
                      }`}
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

          {/* Name */}
          <div>
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

          {/* Description */}
          <div>
            <label
              htmlFor="create-agent-description"
              className="text-muted-foreground mb-2 block text-[12px] font-medium"
            >
              Description
            </label>
            <Textarea
              id="create-agent-description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX))}
              placeholder="What does this agent do?"
              className="bg-secondary/40 border-border/60 min-h-20 resize-none text-[13px]"
            />
            <CharCount value={description} max={DESCRIPTION_MAX} />
          </div>

          {/* System prompt */}
          <div>
            <label
              htmlFor="create-agent-system-prompt"
              className="text-muted-foreground mb-2 block text-[12px] font-medium"
            >
              System prompt
            </label>
            <Textarea
              id="create-agent-system-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value.slice(0, PROMPT_MAX))}
              placeholder="You are a React frontend specialist..."
              className="bg-secondary/40 border-border/60 min-h-16 resize-none text-[13px]"
            />
            <CharCount value={systemPrompt} max={PROMPT_MAX} />
          </div>

          {/* Model selector */}
          <div>
            <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
              Model
            </span>
            <div className="relative">
              <button
                type="button"
                className="border-border/60 text-muted-foreground hover:bg-accent/40 flex h-9 w-full items-center gap-2 rounded-md border px-3 text-[13px] transition-colors"
                onClick={() => {
                  // Cycle through models
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

          {/* Working folder */}
          <div>
            <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
              Default working folder
            </span>
            <button
              type="button"
              className="border-border/60 text-muted-foreground hover:bg-accent/40 flex h-9 w-full items-center gap-2 rounded-md border px-3 text-[13px] transition-colors"
              onClick={() => console.log('[agent] select folder')}
            >
              <Folder className="size-4" />
              <span className="flex-1 text-left">Select folder...</span>
              <ChevronDown className="size-4 opacity-70" />
            </button>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="text-[13px]">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={!name.trim()}
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
