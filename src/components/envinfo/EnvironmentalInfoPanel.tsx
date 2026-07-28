import {
  ArrowUp,
  Check,
  ChevronDown,
  FileCode2,
  FilePlus2,
  FileX2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useGit, type GitChange } from '@/hooks/use-git'
import { useGenerateCommitMessage } from '@/hooks/use-generate-commit-message'
import { useTask } from '@/hooks/use-tasks'
import { FileDiffViewer } from './FileDiffViewer'
import { cn } from '@/lib/utils'
import type { Project } from '@/lib/projects/store'

const FILE_TREE_WIDTH_STORAGE_KEY = 'brightcode:env-info-width'
const FILE_TREE_DEFAULT_WIDTH = 280
const FILE_TREE_MIN_WIDTH = 220
const FILE_TREE_MAX_WIDTH = 520

type CollapsibleKey = 'branch' | 'changes' | 'commit' | 'push' | 'actions' | 'progress'

const COLLAPSED_KEY = 'brightcode:env-info-collapsed'

function getInitialCollapsed(): Record<CollapsibleKey, boolean> {
  if (typeof window === 'undefined') {
    return {
      branch: false,
      changes: false,
      commit: false,
      push: false,
      actions: false,
      progress: false,
    }
  }
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (!raw) {
      return {
        branch: true,
        changes: false,
        commit: false,
        push: false,
        actions: true,
        progress: true,
      }
    }
    const parsed = JSON.parse(raw) as Partial<Record<CollapsibleKey, boolean>>
    return {
      branch: parsed.branch ?? true,
      changes: parsed.changes ?? false,
      commit: parsed.commit ?? false,
      push: parsed.push ?? false,
      actions: parsed.actions ?? true,
      progress: parsed.progress ?? true,
    }
  } catch {
    return {
      branch: true,
      changes: false,
      commit: false,
      push: false,
      actions: true,
      progress: true,
    }
  }
}

function ChangeIcon({ type }: { type: string }) {
  switch (type) {
    case 'A':
      return <FilePlus2 className="size-3.5 shrink-0 text-emerald-500/80" />
    case 'D':
      return <FileX2 className="size-3.5 shrink-0 text-rose-500/80" />
    case 'M':
    case '?':
    case '!':
    case 'R':
    case 'C':
    default:
      return <FileCode2 className="text-muted-foreground size-3.5 shrink-0" />
  }
}

function basename(path: string) {
  return path.split('/').pop() ?? path
}

export function EnvironmentalInfoPanel({
  project,
  taskId,
  open,
  onOpenTerminal,
}: {
  project: Project
  taskId?: string | null
  open: boolean
  onOpenTerminal?: () => void
}) {
  const {
    status,
    loading,
    error,
    committing,
    pushing,
    refresh,
    commit,
    push,
  } = useGit(project)

  const task = useTask(taskId ?? null)
  void task

  const [commitMsg, setCommitMsg] = useState('')
  const [commitSuccess, setCommitSuccess] = useState(false)
  const [pushSuccess, setPushSuccess] = useState(false)
  const [selectedChange, setSelectedChange] = useState<GitChange | null>(null)
  const [width, setWidth] = useState(() => {
    const stored = Number.parseFloat(
      localStorage.getItem(FILE_TREE_WIDTH_STORAGE_KEY) ?? '',
    )
    return Number.isFinite(stored)
      ? Math.min(Math.max(stored, FILE_TREE_MIN_WIDTH), FILE_TREE_MAX_WIDTH)
      : FILE_TREE_DEFAULT_WIDTH
  })
  const [collapsed, setCollapsed] = useState<Record<CollapsibleKey, boolean>>(
    getInitialCollapsed,
  )

  // Auto-open Commit when there are changes and it's empty + commit wasn't explicit closed
  useEffect(() => {
    if (status?.changes.length && !commitMsg) {
      setCollapsed((c) => (c.commit ? { ...c, commit: false } : c))
    }
  }, [status?.changes.length, commitMsg])

  useEffect(() => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  }, [collapsed])

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return
    const ok = await commit(commitMsg)
    setCommitSuccess(ok)
    if (ok) setCommitMsg('')
    setTimeout(() => setCommitSuccess(false), 2500)
  }, [commit, commitMsg])

  const handlePush = useCallback(async () => {
    const ok = await push()
    setPushSuccess(ok)
    setTimeout(() => setPushSuccess(false), 2500)
  }, [push])

  const handleCommitAndPush = useCallback(async () => {
    if (!commitMsg.trim()) return
    if (await commit(commitMsg)) {
      setCommitMsg('')
      setCommitSuccess(true)
      setTimeout(() => setCommitSuccess(false), 2500)
      void handlePush()
    }
  }, [commit, commitMsg, handlePush])

  const toggleSection = (key: CollapsibleKey) => {
    setCollapsed((c) => ({ ...c, [key]: !c[key] }))
  }

  const changeCount = status?.changes.length ?? 0

  return (
    <aside
      aria-label="Environmental Information"
      style={{ width: `${width}px` }}
      className={cn(
        'bg-sidebar/40 relative min-h-0 shrink-0 flex-col border-l',
        open ? 'flex' : 'hidden',
      )}
    >
      <EnvInfoResizeHandle width={width} onResize={setWidth} />

      {/* Header (matches the MiniMax Code style) */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-semibold">
            Environmental Information
          </p>
          <p className="text-muted-foreground truncate font-mono text-[10.5px]">
            {status?.branch ?? (loading ? 'loading…' : '—')}
          </p>
        </div>
        <button
          type="button"
          aria-label="Refresh git status"
          title="Refresh"
          className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {selectedChange ? (
        <FileDiffViewer
          project={project}
          filePath={selectedChange.path}
          isUntracked={selectedChange.type === '?'}
          isDeleted={selectedChange.type === 'D'}
          onBack={() => setSelectedChange(null)}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5">
          {/* Branch (small, always-visible) */}
          <div className="px-1.5 py-2">
            <div className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">
                {status?.branch ?? (loading ? '…' : '—')}
              </span>
              {status && (status.ahead > 0 || status.behind > 0) && (
                <span className="text-muted-foreground ml-auto text-[10px]">
                  {status.ahead > 0 && (
                    <span className="text-emerald-500/80">+{status.ahead}</span>
                  )}
                  {status.ahead > 0 && status.behind > 0 && ' / '}
                  {status.behind > 0 && (
                    <span className="text-amber-500/80">-{status.behind}</span>
                  )}
                </span>
              )}
            </div>
          </div>

          <Section
            title="Changes"
            collapsed={collapsed.changes}
            onToggle={() => toggleSection('changes')}
            count={changeCount > 0 ? changeCount : undefined}
          >
            {error && <p className="text-destructive px-1 text-[11px]">{error}</p>}
            {!error && loading && status === null && (
              <div className="text-muted-foreground flex items-center gap-2 px-1 py-1.5 text-[11px]">
                <LoaderCircle className="size-3 animate-spin" />
                Loading…
              </div>
            )}
            {!error && !loading && status?.changes.length === 0 && (
              <p className="text-muted-foreground px-1 py-1.5 text-[11px]">
                No changes
              </p>
            )}
            {status && status.changes.length > 0 && (
              <div className="space-y-0.5">
                {status.changes.map((change) => {
                  const c: GitChange = change
                  const sc = selectedChange as GitChange | null
                  const isActive = !!(sc && sc.path === c.path)
                  return (
                    <button
                      type="button"
                      key={c.path}
                      onClick={() => setSelectedChange(c)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left text-[11.5px] transition-colors',
                        isActive
                          ? 'bg-accent text-foreground'
                          : 'hover:bg-accent/50 text-foreground/90',
                      )}
                      title={c.path}
                    >
                      <ChangeIcon type={c.type} />
                      <span className="truncate">{basename(c.path)}</span>
                      <span className="text-muted-foreground ml-auto truncate text-[10px]">
                        {c.path.includes('/') ? c.path : ''}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </Section>

          <Section
            title="Commit or push"
            collapsed={collapsed.commit}
            onToggle={() => toggleSection('commit')}
          >
            <CommitForm
              commitMsg={commitMsg}
              onChange={setCommitMsg}
              onCommit={handleCommit}
              onCommitAndPush={handleCommitAndPush}
              committing={committing}
              committingAndPushing={committing || pushing}
              commitSuccess={commitSuccess}
              project={project}
              hasChanges={(changeCount ?? 0) > 0}
            />
          </Section>

          <Section
            title="Push"
            collapsed={collapsed.push}
            onToggle={() => toggleSection('push')}
          >
            {(() => {
              const hasUpstream =
                !!(status?.ahead || status?.behind) || !!error
              const disabled = pushing || !hasUpstream
              const helpText = pushing
                ? 'Pushing to remote…'
                : pushSuccess
                  ? 'Push complete'
                  : !status
                    ? 'Loading git status…'
                    : !hasUpstream
                      ? 'No local commits to push. Commit something first.'
                      : `Push ${status?.ahead ?? 0} commit(s) to remote`
              return (
                <button
                  type="button"
                  onClick={handlePush}
                  disabled={disabled}
                  title={helpText}
                  aria-label={helpText}
                  className={cn(
                    'text-[11.5px] inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
                    pushing
                      ? 'bg-muted text-muted-foreground cursor-not-allowed'
                      : pushSuccess
                        ? 'bg-emerald-500/20 text-emerald-500'
                        : 'text-foreground/80 hover:text-foreground hover:bg-accent/60',
                  )}
                >
                  {pushing ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <GitPullRequest className="size-3.5" />
                  )}
                  {pushing
                    ? 'Pushing…'
                    : pushSuccess
                      ? 'Pushed'
                      : `Push${status?.ahead ? ` (${status.ahead} commits)` : ''}`}
                </button>
              )
            })()}
          </Section>

          <Section
            title="Actions"
            collapsed={collapsed.actions}
            onToggle={() => toggleSection('actions')}
          >
            <button
              type="button"
              onClick={onOpenTerminal}
              className="text-[11.5px] text-foreground/80 hover:text-foreground hover:bg-accent/60 inline-flex h-7 w-full items-center gap-1.5 rounded-md px-2 font-medium transition-colors"
            >
              <SquareTerminal className="size-3.5" />
              Open terminal
            </button>
          </Section>

          <Section
            title="Progress"
            collapsed={collapsed.progress}
            onToggle={() => toggleSection('progress')}
          >
            <ProgressList taskId={taskId} />
          </Section>
        </div>
      )}
    </aside>
  )
}

function Section({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string
  count?: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="px-1 py-1">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/40 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors"
        aria-expanded={!collapsed}
      >
        <span className="text-[12px] font-semibold tracking-tight">
          {title}
          {count !== undefined && (
            <span className="text-muted-foreground/80 ml-1 font-normal">
              {count}
            </span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground ml-auto size-3.5 transition-transform',
            collapsed && '-rotate-90',
          )}
        />
      </button>
      {!collapsed && <div className="mt-0.5 px-1.5 pb-1.5">{children}</div>}
    </div>
  )
}

function ProgressList({ taskId }: { taskId?: string | null }) {
  const task = useTask(taskId ?? null)
  if (!task) {
    return (
      <p className="text-muted-foreground px-1 py-1.5 text-[11px]">No active task</p>
    )
  }
  const steps = task.progress ?? []
  if (steps.length === 0) {
    return (
      <p className="text-muted-foreground px-1 py-1.5 text-[11px]">No active tasks</p>
    )
  }
  return (
    <ul className="space-y-1">
      {steps.map((step) => {
        const done = step.status === 'completed'
        const failed = step.status === 'failed'
        const running = step.status === 'running'
        return (
          <li
            key={step.id}
            className="text-foreground/80 flex items-center gap-1.5 text-[11px]"
            title={step.detail ?? step.title}
          >
            {failed ? (
              <X className="text-destructive size-3.5 shrink-0" />
            ) : done ? (
              <Check className="text-muted-foreground size-3.5 shrink-0" />
            ) : running ? (
              <LoaderCircle className="text-foreground/80 size-3.5 shrink-0 animate-spin" />
            ) : (
              <span className="text-muted-foreground inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border text-[9px] font-medium leading-none">
                {steps.indexOf(step) + 1}
              </span>
            )}
            <span
              className={cn(
                'truncate',
                done && 'line-through opacity-60',
                failed && 'text-destructive/80',
              )}
            >
              {step.title}
              {step.detail ? (
                <span className="text-muted-foreground ml-1 font-mono text-[10px]">
                  {step.detail}
                </span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function CommitForm({
  commitMsg,
  onChange,
  onCommit,
  onCommitAndPush,
  committing,
  committingAndPushing,
  commitSuccess,
  project,
  hasChanges,
}: {
  commitMsg: string
  onChange: (value: string) => void
  onCommit: () => void | Promise<void>
  onCommitAndPush: () => void | Promise<void>
  committing: boolean
  committingAndPushing: boolean
  commitSuccess: boolean
  project: Project
  hasChanges: boolean
}) {
  const task = useTask(null)
  void project
  void task
  // The AI commit-message generator reuses the active task's model + account.
  // Falls back to a reasonable default if no model is selected.
  const { generate, generating, error } = useGenerateCommitMessage(project)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleGenerate = useCallback(async () => {
    if (!hasChanges) {
      setLocalError('No changes to commit')
      return
    }
    setLocalError(null)
    onChange('')
    // Pull the model+account from the active task. The user can override
    // later; for now the simplest path is to reuse the conversation's pick.
    const model = task?.selectedModel ?? 'minimax/MiniMax-M3'
    const accountId = task?.selectedAccountId ?? undefined
    await generate({
      model,
      accountId,
      onChunk: (text) => onChange((commitMsg + text).trimStart()),
    })
  }, [hasChanges, onChange, commitMsg, task, generate])

  const finalError = error ?? localError

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <textarea
          value={commitMsg}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !committing) {
              void onCommit()
            }
          }}
          placeholder="Commit message…"
          rows={2}
          disabled={committing}
          className={cn(
            'bg-accent/30 text-foreground placeholder:text-muted-foreground/60 w-full resize-none rounded-md px-2 py-1.5 pr-7 text-[11.5px] outline-none',
            'focus:bg-accent/50',
            (committing || generating) && 'opacity-60',
          )}
        />
        <button
          type="button"
          onClick={() => void handleGenerate()}
          disabled={generating || committing}
          title="Generate commit message with AI"
          aria-label="Generate commit message with AI"
          className={cn(
            'absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors',
            generating
              ? 'text-foreground'
              : 'hover:text-foreground hover:bg-accent',
          )}
        >
          {generating ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
        </button>
      </div>
      {finalError && (
        <p className="text-destructive px-1 text-[10.5px]">{finalError}</p>
      )}
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => void onCommit()}
          disabled={!commitMsg.trim() || committing}
          className={cn(
            'text-[11.5px] inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md font-medium transition-colors',
            committing
              ? 'bg-muted text-muted-foreground cursor-not-allowed'
              : commitSuccess
                ? 'bg-emerald-500/20 text-emerald-500'
                : 'text-foreground/80 hover:text-foreground hover:bg-accent/60',
          )}
        >
          {committing ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <GitCommitHorizontal className="size-3.5" />
          )}
          Commit
        </button>
        <button
          type="button"
          aria-label="Commit and push"
          title="Commit and push (Ctrl+Enter)"
          onClick={() => void onCommitAndPush()}
          disabled={!commitMsg.trim() || committingAndPushing}
          className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

function EnvInfoResizeHandle({
  width,
  onResize,
}: {
  width: number
  onResize: (width: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    document.documentElement.classList.remove('sidebar-resizing')
  }

  const clamp = (nextWidth: number) =>
    Math.min(Math.max(nextWidth, FILE_TREE_MIN_WIDTH), FILE_TREE_MAX_WIDTH)

  return (
    <div
      role="separator"
      aria-label="Resize environment info panel"
      aria-orientation="vertical"
      aria-valuemin={FILE_TREE_MIN_WIDTH}
      aria-valuemax={FILE_TREE_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="group/env-info-resize absolute inset-y-0 -left-2 z-20 hidden w-4 cursor-col-resize touch-none md:block"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        document.documentElement.classList.add('sidebar-resizing')
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        onResize(clamp(drag.startWidth - (event.clientX - drag.startX)))
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(FILE_TREE_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowLeft' ? 16 : -16
        onResize(clamp(width + delta))
      }}
    >
      <div
        className={cn(
          'mx-auto h-full w-0.5 transition-colors',
          dragging
            ? 'bg-primary/50'
            : 'group-hover/env-info-resize:bg-primary/50',
        )}
      />
    </div>
  )
}

// Suppress unused import warnings for now.
