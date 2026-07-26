import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson2,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ProjectActionItems } from '@/components/projects/ProjectActionItems'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  PROJECT_FILES_CHANGED_EVENT,
  type ProjectFilesChangedDetail,
} from '@/lib/projects/file-events'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

const FILE_TREE_WIDTH_STORAGE_KEY = 'brightcode:file-tree-width'
const FILE_TREE_DEFAULT_WIDTH = 260
const FILE_TREE_MIN_WIDTH = 200
const FILE_TREE_MAX_WIDTH = 520

export type ProjectFileEntry = {
  name: string
  path: string
  isDir: boolean
  size?: number
}

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'html',
  'java',
  'js',
  'jsx',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
])

function getExtension(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function ProjectFileIcon({
  path,
  isDir = false,
  open = false,
}: {
  path: string
  isDir?: boolean
  open?: boolean
}) {
  const extension = getExtension(path)
  if (isDir) {
    return open ? (
      <FolderOpen className="size-3.5 shrink-0 text-amber-500/80" />
    ) : (
      <Folder className="size-3.5 shrink-0 text-amber-500/80" />
    )
  }
  if (extension === 'json' || extension === 'jsonc') {
    return <FileJson2 className="size-3.5 shrink-0 text-amber-500/80" />
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return <FileCode2 className="size-3.5 shrink-0 text-sky-500/80" />
  }
  return <FileText className="text-muted-foreground size-3.5 shrink-0" />
}

function parentPath(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

export function ProjectFileTreePanel({
  project,
  open,
  activePath,
  loadingPath,
  onOpenFile,
}: {
  project: Project
  open: boolean
  activePath: string | null
  loadingPath: string | null
  onOpenFile: (entry: ProjectFileEntry) => void
}) {
  const [width, setWidth] = useState(() => {
    const stored = Number.parseFloat(
      localStorage.getItem(FILE_TREE_WIDTH_STORAGE_KEY) ?? '',
    )
    return Number.isFinite(stored)
      ? Math.min(Math.max(stored, FILE_TREE_MIN_WIDTH), FILE_TREE_MAX_WIDTH)
      : FILE_TREE_DEFAULT_WIDTH
  })
  const [entries, setEntries] = useState<ProjectFileEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshTimerRef = useRef<number | null>(null)

  const refreshTree = useCallback(async () => {
    const api = window.electronAPI?.workspace
    if (!api) {
      setError('The file explorer is available in the desktop app.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await api.listTree(project.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setEntries(result.entries)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    setEntries([])
    setExpanded(new Set())
    setError(null)
  }, [project.id])

  useEffect(() => {
    if (open) void refreshTree()
  }, [open, refreshTree])

  useEffect(() => {
    const handleFilesChanged = (event: Event) => {
      const detail = (event as CustomEvent<ProjectFilesChangedDetail>).detail
      if (!open || detail?.projectId !== project.id) return
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null
        void refreshTree()
      }, 120)
    }

    window.addEventListener(PROJECT_FILES_CHANGED_EVENT, handleFilesChanged)
    return () => {
      window.removeEventListener(PROJECT_FILES_CHANGED_EVENT, handleFilesChanged)
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
    }
  }, [open, project.id, refreshTree])

  useEffect(() => {
    localStorage.setItem(FILE_TREE_WIDTH_STORAGE_KEY, String(width))
  }, [width])

  const childrenByParent = useMemo(() => {
    const map = new Map<string, ProjectFileEntry[]>()
    for (const entry of entries) {
      const parent = parentPath(entry.path)
      const children = map.get(parent)
      if (children) children.push(entry)
      else map.set(parent, [entry])
    }
    return map
  }, [entries])

  const activateEntry = (entry: ProjectFileEntry) => {
    if (!entry.isDir) {
      onOpenFile(entry)
      return
    }
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
  }

  const renderTree = (parent: string, depth: number): React.ReactNode =>
    (childrenByParent.get(parent) ?? []).map((entry) => {
      const isExpanded = entry.isDir && expanded.has(entry.path)
      const isLoading = loadingPath === entry.path
      return (
        <div key={entry.path}>
          <button
            type="button"
            title={entry.path}
            className={cn(
              'hover:bg-accent/60 flex h-6 w-full items-center gap-1 rounded-sm pr-2 text-left text-[12px] transition-colors',
              activePath === entry.path && 'bg-accent text-foreground',
            )}
            style={{ paddingLeft: `${6 + depth * 13}px` }}
            onClick={() => activateEntry(entry)}
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {isLoading ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : entry.isDir ? (
                isExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )
              ) : null}
            </span>
            <ProjectFileIcon path={entry.path} isDir={entry.isDir} open={isExpanded} />
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && renderTree(entry.path, depth + 1)}
        </div>
      )
    })

  return (
    <aside
      aria-label="Project file explorer"
      style={{ width: `${width}px` }}
      className={cn(
        'bg-sidebar/40 relative min-h-0 shrink-0 flex-col border-l',
        open ? 'flex' : 'hidden',
      )}
    >
      <RightPanelResizeHandle width={width} onResize={setWidth} />

      <div className="flex h-12 shrink-0 items-center justify-between border-b px-3">
        <div className="min-w-0">
          <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.08em] uppercase">
            Explorer
          </p>
          <p className="truncate text-[11px] font-medium">{project.label}</p>
        </div>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Refresh project files"
            title="Refresh files"
            className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md"
            onClick={() => void refreshTree()}
            disabled={loading}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Project actions"
                title="Project actions"
                className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md"
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <ProjectActionItems project={project} onError={setError} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {error && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2 text-[11px]">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
            <X className="size-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1.5">
        {loading && entries.length === 0 ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-[12px]">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading files…
          </div>
        ) : entries.length === 0 && !error ? (
          <p className="text-muted-foreground px-2 py-3 text-[12px]">
            No files found.
          </p>
        ) : (
          renderTree('', 0)
        )}
      </div>
    </aside>
  )
}

function RightPanelResizeHandle({
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

  useEffect(
    () => () => document.documentElement.classList.remove('sidebar-resizing'),
    [],
  )

  return (
    <div
      role="separator"
      aria-label="Resize project file explorer"
      aria-orientation="vertical"
      aria-valuemin={FILE_TREE_MIN_WIDTH}
      aria-valuemax={FILE_TREE_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="group/file-tree-resize absolute inset-y-0 -left-2 z-20 hidden w-4 cursor-col-resize touch-none md:block"
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
            : 'group-hover/file-tree-resize:bg-primary/50',
        )}
      />
    </div>
  )
}
