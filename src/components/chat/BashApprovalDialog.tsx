/**
 * Bash approval dialog.
 *
 * The `bash` agent tool is gated by an explicit per-call approval. The
 * main process emits a `tool:bash-approval-request` event with the
 * exact command and its resolved working directory; this component
 * shows a modal so the user can confirm or deny, then sends the
 * decision back through the preload bridge.
 *
 * One instance lives at the AppShell level — there's only ever one
 * approval in flight at a time (the model waits for the response
 * before continuing), so a single dialog is enough.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, TerminalSquare } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface PendingApproval {
  approvalId: string
  command: string
  workdir: string
  timeoutMs: number
}

function formatTimeout(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)} min`
}

export function BashApprovalDialog() {
  const [pending, setPending] = useState<PendingApproval | null>(null)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.tools?.onBashApprovalRequest) return
    return api.tools.onBashApprovalRequest((req) => {
      setPending({
        approvalId: req.approvalId,
        command: req.command,
        workdir: req.workdir,
        timeoutMs: req.timeoutMs,
      })
    })
  }, [])

  const respond = useCallback(
    (approved: boolean) => {
      // Clear synchronously before IPC to prevent double-fire from
      // simultaneous Enter key + button click, or rapid double-click.
      const current = pending
      if (!current || !window.electronAPI?.tools?.respondToBashApproval) return
      setPending(null) // optimistic clear — now `pending` is null for any racing call
      window.electronAPI.tools.respondToBashApproval(current.approvalId, approved)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // intentionally depend on nothing — always reads the *current* `pending` from closure
  )

  // Esc → deny. Enter → approve (only when the dialog is open).
  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        respond(false)
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        respond(true)
      }
    }
    // Capture phase so we beat the chat input from also handling Enter.
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [pending, respond])

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && pending) respond(false)
      }}
    >
      <DialogContent className="max-w-xl gap-0 p-0">
        {pending && (
          <div className="flex flex-col">
            <div className="border-border/60 flex items-start gap-3 border-b px-5 pt-5 pb-3">
              <div className="bg-amber-500/15 text-amber-600 dark:text-amber-400 mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md">
                <AlertTriangle className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle>Run shell command?</DialogTitle>
                <DialogDescription className="mt-1">
                  The model wants to run a shell command in your active
                  project. Review the exact command before approving.
                </DialogDescription>
              </div>
            </div>

            <div className="space-y-3 px-5 pt-4 pb-3">
              <div>
                <div className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                  Command
                </div>
                <pre className="bg-muted/60 text-foreground max-h-48 overflow-auto rounded-md border px-3 py-2 font-mono text-[12.5px] leading-relaxed break-all whitespace-pre-wrap">
                  {pending.command}
                </pre>
              </div>
              <div className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]">
                <div className="flex items-center gap-1.5">
                  <TerminalSquare className="size-3.5" />
                  <span className="text-foreground/70 font-mono">
                    {pending.workdir}
                  </span>
                </div>
                <div>
                  Timeout:{' '}
                  <span className="text-foreground/80">
                    {formatTimeout(pending.timeoutMs)}
                  </span>
                </div>
              </div>
            </div>

            <div className="bg-muted/30 border-border/60 flex items-center justify-end gap-2 border-t px-5 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => respond(false)}
              >
                Deny
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => respond(true)}
                autoFocus
              >
                Approve
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
