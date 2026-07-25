import { useState } from 'react'
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

const NAME_MAX = 20
const DESCRIPTION_MAX = 100

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
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const reset = () => {
    setName('')
    setDescription('')
  }

  const handleCreate = () => {
    console.log('[agent] create', { name: name.trim(), description: description.trim() })
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
          {/* Icon picker */}
          <div>
            <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
              Icon
            </span>
            <button
              type="button"
              className="bg-secondary ring-border/60 hover:ring-ring/60 flex size-14 items-center justify-center rounded-full text-xl font-medium ring-1 transition-shadow"
              onClick={() => console.log('[agent] pick icon')}
              aria-label="Pick agent icon"
            >
              {(name.trim()[0] ?? 'A').toUpperCase()}
            </button>
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
