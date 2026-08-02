import { useState } from 'react'
import { Monitor, Signal } from 'lucide-react'
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { avatarSvg } from '@/components/ui/agent-avatar'
import { cn } from '@/lib/utils'

const NAME_MAX = 20
const DESCRIPTION_MAX = 100

const navItems = [
  { id: 'profile', label: 'Agent profile', icon: Monitor },
  { id: 'im', label: 'IM', icon: Signal },
] as const

type NavId = (typeof navItems)[number]['id']

export function AgentSettingDialog({
  open,
  onOpenChange,
  agentName,
  avatarSeed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentName: string
  avatarSeed: string
}) {
  const [tab, setTab] = useState<NavId>('profile')
  const [name, setName] = useState(agentName)
  const [description, setDescription] = useState(
    'Node.js backend specialist. Builds APIs, queues, integrations and tests for the teams.',
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl overflow-hidden p-0"
        style={{ height: 'min(420px, calc(100dvh - 2rem))' }}
      >
        <div className="flex h-full">
          {/* Internal left nav */}
          <nav className="border-border/60 flex w-40 shrink-0 flex-col border-r px-2 py-4">
            <span className="text-muted-foreground/70 px-2 pb-2 text-[11px] font-normal tracking-wide uppercase">
              Agent Setting
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

          {/* Right pane */}
          <div className="flex min-w-0 flex-1 flex-col p-5">
            <div className="flex items-center justify-between">
              <DialogTitle>
                {tab === 'profile' ? 'Agent profile' : 'IM'}
              </DialogTitle>
              <DialogCloseButton />
            </div>

            {tab === 'profile' ? (
              <div className="mt-5 flex min-h-0 flex-1 flex-col gap-4">
                {/* Icon preview */}
                <div>
                  <span className="text-muted-foreground mb-2 block text-[12px] font-medium">
                    Avatar
                  </span>
                  <button
                    type="button"
                    className="ring-border/60 hover:ring-ring/60 flex size-14 items-center justify-center overflow-hidden rounded-full bg-secondary ring-1 transition-shadow"
                    onClick={() => console.log('[agent] pick avatar')}
                    aria-label="Pick agent avatar"
                  >
                    <span
                      className="block size-14"
                      dangerouslySetInnerHTML={{ __html: avatarSvg(avatarSeed, 56) }}
                    />
                  </button>
                </div>

                {/* Name */}
                <div>
                  <label
                    htmlFor="agent-setting-name"
                    className="text-muted-foreground mb-2 block text-[12px] font-medium"
                  >
                    Name <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="agent-setting-name"
                    value={name}
                    onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))}
                    className="bg-secondary/40 border-border/60 h-9 text-[13px]"
                  />
                  <span className="text-muted-foreground/70 block pt-1 text-right text-[11px] tabular-nums">
                    {name.length}/{NAME_MAX}
                  </span>
                </div>

                {/* Description */}
                <div className="flex min-h-0 flex-1 flex-col">
                  <label
                    htmlFor="agent-setting-description"
                    className="text-muted-foreground mb-2 block text-[12px] font-medium"
                  >
                    Description
                  </label>
                  <Textarea
                    id="agent-setting-description"
                    value={description}
                    onChange={(e) =>
                      setDescription(e.target.value.slice(0, DESCRIPTION_MAX))
                    }
                    className="bg-secondary/40 border-border/60 min-h-16 flex-1 resize-none text-[13px]"
                  />
                  <span className="text-muted-foreground/70 block pt-1 text-right text-[11px] tabular-nums">
                    {description.length}/{DESCRIPTION_MAX}
                  </span>
                </div>

                <div className="flex justify-end pt-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      console.log('[agent] save profile', { name, description })
                      onOpenChange(false)
                    }}
                    className="bg-primary text-primary-foreground hover:bg-primary/90 text-[13px]"
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-5">
                <p className="text-foreground text-[13px] font-medium">
                  Instant messaging
                </p>
                <p className="text-muted-foreground pt-1 text-[13px] leading-5">
                  Connect this agent to an IM platform to chat with it from
                  your phone or desktop messenger.
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
