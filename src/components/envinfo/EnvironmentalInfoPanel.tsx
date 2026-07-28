import {
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  ArrowUp,
  FileCode2,
  FilePlus2,
  FileX2,
  LoaderCircle,
  RefreshCw,
  SquareTerminal,
} from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useGit, type GitChange } from '@/hooks/use-git'
import { cn } from '@/lib/utils'
import type { Project } from '@/lib/projects/store'

const FILE_TREE_WIDTH_STORAGE_KEY = 'brightcode:env-info-width'
const FILE_TREE_DEFAULT_WIDTH = 280
const FILE_TREE_MIN_WIDTH = 220
const FILE_TREE_MAX_WIDTH = 520

function ChangeIcon({ type }: { type: string }) {
  switch (type) {
    case 'M':
      return <FileCode2 className="size-3.5 shrink-0 text-sky-500/80" />
    case 'A':
      return <FilePlus2 className="size-3.5 shrink-0 text-emerald-500/80" />
    case 'D':
      return <FileX2 className="size-3.5 shrink-0 text-rose-500/80" />
    default:
      return <FileCode2 className="text-muted-foreground size-3.5 shrink-0" />
  }
}

function ChangeLabel({ type }: { type: string }) {
  switch (type) {
    case 'M':
      return 'Modified'
    case 'A':
      return 'Added'
    case 'D':
      return 'Deleted'
    case 'R':
      return 'Renamed'
    case 'C':
      return 'Copied'
    case '?':
      return 'Untracked'
    case '!':
      return 'Ignored'
    default:
      return type
  }
}

export function EnvironmentalInfoPanel({
  project,
  open,
  onOpenTerminal,
}: {
  project: Project
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

  const [commitMsg, setCommitMsg] = useState('')
  const [commitSuccess, setCommitSuccess] = useState(false)
  const [pushSuccess, setPushSuccess] = useState(false)
  const [width, setWidth] = useState(() => {
    const stored = Number.parseFloat(
      localStorage.getItem(FILE_TREE_WIDTH_STORAGE_KEY) ?? '',
    )
    return Number.isFinite(stored)
      ? Math.min(Math.max(stored, FILE_TREE_MIN_WIDTH), FILE_TREE_MAX_WIDTH)
      : FILE_TREE_DEFAULT_WIDTH
  })

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
      {/* Resize handle */}
      <EnvInfoResizeHandle width={width} onResize={setWidth} />

      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.08em] uppercase">
            Environment
          </p>
          <p className="truncate text-[11px] font-medium">{project.label}</p>
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Branch */}
        <Section title="Branch">
          <div className="flex items-center gap-1.5 text-[12px]">
            <GitBranch className="text-muted-foreground size-3.5 shrink-0" />
            <span className="font-mono font-medium">
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
        </Section>

        {/* Changes */}
        <Section
          title={
            <span className="flex items-center gap-1.5">
              Changes
              {changeCount > 0 && (
                <span className="bg-muted text-muted-foreground inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium leading-none">
                  {changeCount}
                </span>
              )}
            </span>
          }
        >
          {error && (
            <p className="text-destructive px-1 text-[11px]">{error}</p>
          )}
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
              {status.changes.map((change: GitChange) => (
                <div
                  key={change.path}
                  className="hover:bg-accent/50 flex items-center gap-1.5 rounded-sm px-1 py-0.5 text-[11px]"
                  title={`${ChangeLabel({ type: change.type })}: ${change.path}`}
                >
                  <span className="shrink-0 font-mono text-[10px] font-bold uppercase tracking-wide text-muted-foreground/60">
                    {change.type}
                  </span>
                  <ChangeIcon type={change.type} />
                  <span className="truncate">{change.path}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Commit */}
        <Section title="Commit">
          <div className="space-y-1.5">
            <input
              type="text"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !committing) void handleCommit()
              }}
              placeholder="Commit message…"
              className="bg-accent/40 text-foreground placeholder:text-muted-foreground/50 h-7 w-full rounded-md px-2 text-[11px] outline-none"
              disabled={committing}
            />
            <div className="flex gap-1">
              <button
                type="button"
                onClick={handleCommit}
                disabled={!commitMsg.trim() || committing}
                className={cn(
                  'text-[11px] inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md font-medium transition-colors',
                  committing
                    ? 'bg-muted text-muted-foreground cursor-not-allowed'
                    : commitSuccess
                      ? 'bg-emerald-500/20 text-emerald-500'
                      : 'bg-accent/60 hover:bg-accent text-foreground',
                )}
              >
                {committing ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <GitCommitHorizontal className="size-3.5" />
                )}
                {committing ? 'Committing…' : 'Commit'}
              </button>
              <button
                type="button"
                aria-label="Commit & Push"
                title="Commit & Push"
                onClick={async () => {
                  if (await commit(commitMsg)) {
                    setCommitMsg('')
                    setCommitSuccess(true)
                    setTimeout(() => setCommitSuccess(false), 2500)
                    void handlePush()
                  }
                }}
                disabled={!commitMsg.trim() || committing || pushing}
                className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
              >
                <ArrowUp className="size-3.5" />
              </button>
            </div>
          </div>
        </Section>

        {/* Push */}
        <Section title="Push">
          <button
            type="button"
            onClick={handlePush}
            disabled={pushing || (!status?.ahead && !status?.behind && !error)}
            className={cn(
              'text-[11px] inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
              pushing
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : pushSuccess
                  ? 'bg-emerald-500/20 text-emerald-500'
                  : 'bg-accent/60 hover:bg-accent text-foreground',
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
                ? 'Pushed!'
                : `Push${status?.ahead ? ` (${status.ahead} commits)` : ''}`}
          </button>
        </Section>

        {/* Actions */}
        <Section title="Actions">
          <button
            type="button"
            onClick={onOpenTerminal}
            className="text-[11px] bg-accent/60 hover:bg-accent text-foreground inline-flex h-7 w-full items-center justify-center gap-1.5 rounded-md font-medium transition-colors"
          >
            <SquareTerminal className="size-3.5" />
            Open Terminal
          </button>
        </Section>

        {/* Progress */}
        <Section title="Progress">
          <p className="text-muted-foreground px-1 py-1.5 text-[11px]">
            No active tasks
          </p>
        </Section>
      </div>
    </aside>
  )
}

function Section({
  title,
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="border-border/30 border-b py-2">
      <div className="text-muted-foreground mb-1 px-3 text-[10px] font-semibold tracking-[0.06em] uppercase">
        {title}
      </div>
      <div className="px-3">{children}</div>
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
