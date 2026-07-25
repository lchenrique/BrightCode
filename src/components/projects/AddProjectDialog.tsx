/**
 * AddProjectDialog — pops when the user clicks "+" next to "Projects" in
 * the sidebar. Lets them add an existing folder, clone a remote repo, or
 * create a new empty project. The new project becomes the active one.
 *
 * "Default projects folder" lives at `~/BrightCodeProjects/` (created on
 * demand by the main process) — so "Create new project" with an empty
 * name drops the user into that folder picker; a typed name puts the
 * project at `~/BrightCodeProjects/<name>`.
 */

import { useCallback, useEffect, useState } from 'react'
import { Folder, Globe, Plus, X, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useProjectsActions } from '@/hooks/use-projects'

type Mode = 'browse' | 'clone' | 'create'

interface AddProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const [mode, setMode] = useState<Mode>('browse')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mode-specific state
  const [path, setPath] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')
  const [newName, setNewName] = useState('')

  const { add } = useProjectsActions()

  // Reset on open
  useEffect(() => {
    if (open) {
      setError(null)
      setPath('')
      setCloneUrl('')
      setCloneDest('')
      setNewName('')
    }
  }, [open])

  // ── Handlers ────────────────────────────────────────────────────────

  const handleBrowse = useCallback(async () => {
    if (!window.electronAPI?.fs) {
      setError('Folder picker is only available in the desktop app')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI.fs.browse(path || undefined)
      if (result.ok && result.path) {
        setPath(result.path)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [path])

  const handleSubmitBrowse = useCallback(async () => {
    if (!path.trim()) {
      setError('Pick a folder first')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await add(path.trim())
      if (result.ok) {
        onOpenChange(false)
      } else {
        setError(result.error)
      }
    } finally {
      setBusy(false)
    }
  }, [add, onOpenChange, path])

  const handleClone = useCallback(async () => {
    if (!cloneUrl.trim()) {
      setError('Remote URL is required')
      return
    }
    const dest = cloneDest.trim() || await defaultDestFor(cloneUrl)
    if (!dest) {
      setError('Could not determine destination path')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await window.electronAPI!.fs.clone(cloneUrl.trim(), dest)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const addRes = await add(result.path)
      if (addRes.ok) {
        onOpenChange(false)
      } else {
        setError(addRes.error)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [add, cloneDest, cloneUrl, onOpenChange])

  const handleCreate = useCallback(async () => {
    if (!window.electronAPI?.fs) {
      setError('Folder creation is only available in the desktop app')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const baseDir = await window.electronAPI.fs.defaultProjectsDir()
      const target = newName.trim()
        ? `${baseDir}/${slugify(newName)}`
        : baseDir
      const mkdir = await window.electronAPI.fs.createDir(target)
      if (!mkdir.ok) {
        setError(mkdir.error)
        return
      }
      const addRes = await add(mkdir.path, newName.trim() || undefined)
      if (addRes.ok) {
        onOpenChange(false)
      } else {
        setError(addRes.error)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [add, newName, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-2">
          <DialogTitle className="text-base">Add a project</DialogTitle>
          <DialogCloseButton asChild>
            <button type="button" aria-label="Close">
              <X />
            </button>
          </DialogCloseButton>
        </div>

        {/* Host row (local only for now, future: SSH/Remote) */}
        <div className="text-muted-foreground flex items-center gap-2 px-5 pt-1 pb-3 text-[12px]">
          <span>Host</span>
          <span className="bg-accent text-foreground rounded-md px-2 py-0.5 text-[12px] font-medium">
            Local {navigatorPlatformLabel()}
          </span>
        </div>

        <div className="px-5 pb-5">
          {/* Browse */}
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleBrowse().then(() => setMode('browse'))}
            className="hover:bg-accent/60 group flex w-full items-start gap-3 rounded-lg border border-border/60 bg-transparent p-3 text-left transition-colors disabled:opacity-50"
          >
            <span className="bg-accent text-foreground mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md">
              <Folder className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">
                Browse folder
                {path && (
                  <span className="text-muted-foreground ml-2 font-normal">
                    · {shortenPath(path)}
                  </span>
                )}
              </span>
              <span className="text-muted-foreground block text-[12px]">
                Local project, Git repo, or folder with many repos
              </span>
            </span>
          </button>

          {/* Other ways */}
          <div className="text-muted-foreground mt-4 mb-1.5 text-[11px] font-medium tracking-wide uppercase">
            Other ways to add
          </div>

          <div className="rounded-lg border border-border/60 overflow-hidden">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('clone')}
              className="hover:bg-accent/60 flex w-full items-start gap-3 p-3 text-left transition-colors border-b border-border/60 disabled:opacity-50 data-[active=true]:bg-accent/40"
              data-active={mode === 'clone'}
            >
              <span className="text-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center">
                <Globe className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-[13px] font-medium">
                  Clone from URL
                </span>
                <span className="text-muted-foreground block text-[12px]">
                  Clone a remote Git repository
                </span>
              </span>
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('create')}
              className="hover:bg-accent/60 flex w-full items-start gap-3 p-3 text-left transition-colors disabled:opacity-50 data-[active=true]:bg-accent/40"
              data-active={mode === 'create'}
            >
              <span className="text-foreground mt-0.5 flex size-7 shrink-0 items-center justify-center">
                <Plus className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-foreground block text-[13px] font-medium">
                  Create new project
                </span>
                <span className="text-muted-foreground block text-[12px]">
                  Start from an empty folder
                </span>
              </span>
            </button>
          </div>

          {/* Mode-specific expansion */}
          {mode === 'clone' && (
            <div className="mt-3 space-y-2 rounded-lg border border-border/60 p-3">
              <Input
                placeholder="https://github.com/owner/repo.git"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <Input
                placeholder="Destination folder (optional)"
                value={cloneDest}
                onChange={(e) => setCloneDest(e.target.value)}
                disabled={busy}
              />
              <Button
                onClick={() => void handleClone()}
                disabled={busy || !cloneUrl.trim()}
                className="w-full"
                size="sm"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Clone and add'}
              </Button>
            </div>
          )}

          {mode === 'create' && (
            <div className="mt-3 space-y-2 rounded-lg border border-border/60 p-3">
              <Input
                placeholder="Project name (optional)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                disabled={busy}
                autoFocus
              />
              <p className="text-muted-foreground text-[11px]">
                Creates at <code className="bg-accent rounded px-1">~/BrightCodeProjects/&lt;name&gt;</code>.
                Leave the name blank to use the folder itself.
              </p>
              <Button
                onClick={() => void handleCreate()}
                disabled={busy}
                className="w-full"
                size="sm"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Create and add'}
              </Button>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-destructive mt-3 text-[12px]" role="alert">
              {error}
            </p>
          )}

          {/* Bottom action for browse mode */}
          {mode === 'browse' && (
            <div className="mt-3 flex justify-end">
              <Button
                onClick={() => void handleSubmitBrowse()}
                disabled={busy || !path.trim()}
                size="sm"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : 'Add project'}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function navigatorPlatformLabel(): string {
  if (typeof navigator === 'undefined') return 'Local'
  const p = navigator.platform || ''
  if (/Win/.test(p)) return 'Windows'
  if (/Mac|iPhone|iPad/.test(p)) return 'macOS'
  if (/Linux/.test(p)) return 'Linux'
  return 'Local'
}

function shortenPath(p: string): string {
  if (p.length <= 40) return p
  return `…${p.slice(p.length - 37)}`
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project'
}

async function defaultDestFor(url: string): Promise<string | null> {
  if (!window.electronAPI?.fs) return null
  // Best-effort: extract last path segment and put it under the default dir.
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  const last = cleaned.split('/').filter(Boolean).pop()
  if (!last) return null
  const base = await window.electronAPI.fs.defaultProjectsDir()
  return `${base}/${slugify(last)}`
}

// Suppress unused import warning for DialogDescription (used implicitly
// via Radix accessibility tree).
void DialogDescription
