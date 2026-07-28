import {
  Columns2,
  FileCode2,
  LoaderCircle,
  Save,
  X,
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { ChatSurface } from '@/components/chat/ChatSurface'
import { AgentRuntimeTranscript } from '@/components/chat/AgentRuntimeTranscript'
import {
  ProjectFileIcon,
  ProjectFileTreePanel,
  type ProjectFileEntry,
} from '@/components/files/ProjectFileTreePanel'
import { EnvironmentalInfoPanel } from '@/components/envinfo/EnvironmentalInfoPanel'
import { ViewTopBar } from '@/components/layout/ViewTopBar'
import { TerminalPanel } from '@/components/terminal/TerminalPanel'
import {
  consumePendingProjectFileOpen,
  notifyProjectFilesChanged,
  OPEN_PROJECT_FILE_EVENT,
  type OpenProjectFileDetail,
} from '@/lib/projects/file-events'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

import { DocumentDualEditor } from '@/components/files/DocumentDualEditor'

const CodeEditor = lazy(() =>
  import('@/components/files/CodeEditor').then((module) => ({
    default: module.CodeEditor,
  })),
)

type OpenFile = {
  path: string
  name: string
  language: string
  content: string
  savedContent: string
}

const SPLIT_DEFAULT_PERCENT = 50
const SPLIT_MIN_PERCENT = 25
const SPLIT_MAX_PERCENT = 75
const SPLIT_SIZE_STORAGE_KEY = 'brightcode:workspace-split-percent'
const FILE_TAB_DRAG_TYPE = 'application/x-brightcode-file'
const TERMINAL_HEIGHT_STORAGE_KEY = 'brightcode:terminal-panel-height'
const TERMINAL_DEFAULT_HEIGHT = 260
const TERMINAL_MIN_HEIGHT = 140

function getExtension(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function detectLanguage(path: string): string {
  const languages: Record<string, string> = {
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    html: 'html',
    htm: 'html',
    java: 'java',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    jsonc: 'json',
    md: 'markdown',
    mdx: 'markdown',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'shell',
    sql: 'sql',
    svelte: 'html',
    swift: 'swift',
    ts: 'typescript',
    tsx: 'typescript',
    vue: 'html',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
  }
  return languages[getExtension(path)] ?? 'plaintext'
}

function WorkspaceTabs({
  tabs,
  activeSurface,
  selectedFilePath,
  splitFilePath,
  onSelectFile,
  onCloseFile,
  onSplitFile,
  onDragStateChange,
}: {
  tabs: OpenFile[]
  activeSurface: 'chat' | 'file'
  selectedFilePath: string | null
  splitFilePath: string | null
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
  onSplitFile: (path: string | null) => void
  onDragStateChange: (path: string | null) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex h-full min-w-0 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((file) => {
        const active =
          activeSurface === 'file' && selectedFilePath === file.path
        const dirty = file.content !== file.savedContent
        return (
          <div
            key={file.path}
            draggable
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={file.path}
            className={cn(
              'group relative flex h-full max-w-[170px] min-w-[104px] shrink-0 items-center gap-1.5 border-l px-2.5 text-[11px]',
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              'cursor-grab active:cursor-grabbing',
            )}
            data-file-tab={file.path}
            onClick={() => onSelectFile(file.path)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData(FILE_TAB_DRAG_TYPE, file.path)
              onDragStateChange(file.path)
            }}
            onDragEnd={() => onDragStateChange(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelectFile(file.path)
              }
            }}
            onAuxClick={(event) => {
              if (event.button === 1) onCloseFile(file.path)
            }}
          >
            {active && (
              <span className="bg-primary absolute inset-x-0 bottom-0 h-0.5" />
            )}
            <ProjectFileIcon path={file.path} />
            <span className="truncate">{file.name}</span>
            <button
              type="button"
              aria-label={
                splitFilePath === file.path
                  ? `Move ${file.name} back to the main group`
                  : `Open ${file.name} side by side`
              }
              title={
                splitFilePath === file.path
                  ? 'Move to main group'
                  : 'Open side by side'
              }
              className={cn(
                'hover:bg-accent inline-flex size-4.5 shrink-0 items-center justify-center rounded',
                splitFilePath === file.path
                  ? 'text-primary'
                  : 'opacity-0 group-hover:opacity-100 focus:opacity-100',
              )}
              onClick={(event) => {
                event.stopPropagation()
                onSplitFile(
                  splitFilePath === file.path ? null : file.path,
                )
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <Columns2 className="size-3" />
            </button>
            <button
              type="button"
              aria-label={`Close ${file.name}`}
              className="hover:bg-accent ml-auto inline-flex size-4.5 shrink-0 items-center justify-center rounded"
              onClick={(event) => {
                event.stopPropagation()
                onCloseFile(file.path)
              }}
            >
              {dirty && (
                <span className="bg-foreground size-1.5 rounded-full group-hover:hidden" />
              )}
              <X
                className={cn(
                  'size-3',
                  dirty
                    ? 'hidden group-hover:block'
                    : 'opacity-0 group-hover:opacity-100',
                )}
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function TaskWorkspace({
  title,
  taskId,
  project,
  initialMessage,
  explorerOpen,
  onToggleExplorer,
  envInfoOpen,
  onToggleEnvInfo,
}: {
  title: string
  taskId: string
  project: Project | null
  initialMessage: {
    text: string
    images: Array<{ id: string; data: string; mediaType: string; name: string; size: number }>
  } | null
  explorerOpen: boolean
  onToggleExplorer?: () => void
  envInfoOpen: boolean
  onToggleEnvInfo?: () => void
}) {
  const agentRuntimeV2 = new URLSearchParams(window.location.search)
    .get('agentRuntimeV2') === '1'
  const [tabs, setTabs] = useState<OpenFile[]>([])
  const [activeSurface, setActiveSurface] = useState<'chat' | 'file'>('chat')
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [splitFilePath, setSplitFilePath] = useState<string | null>(null)
  const [draggedTabPath, setDraggedTabPath] = useState<string | null>(null)
  const [splitPercent, setSplitPercent] = useState(() => {
    const stored = Number.parseFloat(
      window.localStorage.getItem(SPLIT_SIZE_STORAGE_KEY) ?? '',
    )
    return Number.isFinite(stored)
      ? clampSplitPercent(stored)
      : SPLIT_DEFAULT_PERCENT
  })
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(() => {
    const stored = Number.parseFloat(
      window.localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY) ?? '',
    )
    return Number.isFinite(stored)
      ? Math.max(TERMINAL_MIN_HEIGHT, stored)
      : TERMINAL_DEFAULT_HEIGHT
  })
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const selectedFile =
    tabs.find((file) => file.path === selectedFilePath) ?? null
  const splitFile =
    tabs.find((file) => file.path === splitFilePath) ?? null
  const visibleFile = splitFile ?? selectedFile

  useEffect(() => {
    setTabs([])
    setActiveSurface('chat')
    setSelectedFilePath(null)
    setSplitFilePath(null)
    setDraggedTabPath(null)
    setError(null)
    setSaveNotice(null)
  }, [project?.id, taskId])

  useEffect(() => {
    window.localStorage.setItem(
      SPLIT_SIZE_STORAGE_KEY,
      String(splitPercent),
    )
  }, [splitPercent])

  useEffect(() => {
    window.localStorage.setItem(
      TERMINAL_HEIGHT_STORAGE_KEY,
      String(terminalHeight),
    )
  }, [terminalHeight])

  useEffect(() => {
    const toggleTerminal = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.code !== 'Backquote') {
        return
      }
      event.preventDefault()
      if (project) setTerminalOpen((open) => !open)
    }
    window.addEventListener('keydown', toggleTerminal)
    return () => window.removeEventListener('keydown', toggleTerminal)
  }, [project])

  useEffect(() => {
    if (!saveNotice) return
    const timer = window.setTimeout(() => setSaveNotice(null), 2200)
    return () => window.clearTimeout(timer)
  }, [saveNotice])

  const openFile = useCallback(
    async (entry: ProjectFileEntry) => {
      const existing = tabs.find((file) => file.path === entry.path)
      if (existing) {
        setSelectedFilePath(existing.path)
        setActiveSurface('file')
        if (splitFilePath) setSplitFilePath(existing.path)
        return
      }
      if (!project) return

      const api = window.electronAPI?.workspace
      if (!api) {
        setError('The internal editor is available in the desktop app.')
        return
      }

      setLoadingPath(entry.path)
      setError(null)
      try {
        const result = await api.readFile(project.id, entry.path)
        if (!result.ok) {
          setError(result.error)
          return
        }
        const file: OpenFile = {
          path: entry.path,
          name: entry.name,
          language: detectLanguage(entry.path),
          content: result.content,
          savedContent: result.content,
        }
        setTabs((current) =>
          current.some((tab) => tab.path === entry.path)
            ? current
            : [...current, file],
        )
        setSelectedFilePath(entry.path)
        setActiveSurface('file')
        if (splitFilePath) setSplitFilePath(entry.path)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingPath((current) => (current === entry.path ? null : current))
      }
    },
    [project, splitFilePath, tabs],
  )

  useEffect(() => {
    if (!project) return

    const openRequestedFile = (detail: OpenProjectFileDetail) => {
      if (detail.projectId !== project.id) return
      void openFile({
        name: detail.name,
        path: detail.path,
        isDir: false,
      })
    }
    const handleOpenRequest = (event: Event) => {
      openRequestedFile(
        (event as CustomEvent<OpenProjectFileDetail>).detail,
      )
    }

    window.addEventListener(OPEN_PROJECT_FILE_EVENT, handleOpenRequest)
    const pending = consumePendingProjectFileOpen(project.id)
    if (pending) openRequestedFile(pending)

    return () =>
      window.removeEventListener(OPEN_PROJECT_FILE_EVENT, handleOpenRequest)
  }, [openFile, project])

  const closeFile = useCallback(
    (path: string) => {
      const index = tabs.findIndex((file) => file.path === path)
      if (index < 0) return
      const file = tabs[index]!
      if (
        file.content !== file.savedContent &&
        !window.confirm(`Close ${file.name} without saving your changes?`)
      ) {
        return
      }

      const nextTabs = tabs.filter((tab) => tab.path !== path)
      setTabs(nextTabs)
      if (splitFilePath === path) {
        setSplitFilePath(null)
        setActiveSurface('chat')
      }
      if (selectedFilePath === path) {
        const nextFile = nextTabs[Math.min(index, nextTabs.length - 1)] ?? null
        setSelectedFilePath(nextFile?.path ?? null)
        if (!nextFile || splitFilePath === path) setActiveSurface('chat')
      }
    },
    [selectedFilePath, splitFilePath, tabs],
  )

  const saveFile = useCallback(async (path: string) => {
    const fileToSave = tabs.find((file) => file.path === path)
    if (!fileToSave || !project || savingPath) return
    const api = window.electronAPI?.workspace
    if (!api) {
      setError('Saving is available in the desktop app.')
      return
    }

    const contentBeingSaved = fileToSave.content
    setSavingPath(fileToSave.path)
    setError(null)
    try {
      const result = await api.writeFile(
        project.id,
        fileToSave.path,
        contentBeingSaved,
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      setTabs((current) =>
        current.map((file) =>
          file.path === fileToSave.path
            ? { ...file, savedContent: contentBeingSaved }
            : file,
        ),
      )
      setSaveNotice(`${fileToSave.name} saved`)
      notifyProjectFilesChanged(project.id, fileToSave.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPath(null)
    }
  }, [project, savingPath, tabs])

  const openInSplit = useCallback((path: string | null) => {
    setSplitFilePath(path)
    if (path) {
      setSelectedFilePath(path)
      setActiveSurface('file')
    }
  }, [])

  return (
    <div className="flex h-full flex-col">
      <ViewTopBar
        title={title}
        titleTabActive={activeSurface === 'chat'}
        onSelectTitleTab={() => setActiveSurface('chat')}
        tabs={
          <WorkspaceTabs
            tabs={tabs}
            activeSurface={activeSurface}
            selectedFilePath={selectedFilePath}
            splitFilePath={splitFilePath}
            onSelectFile={(path) => {
              setSelectedFilePath(path)
              setActiveSurface('file')
              if (splitFilePath) setSplitFilePath(path)
            }}
            onCloseFile={closeFile}
            onSplitFile={openInSplit}
            onDragStateChange={setDraggedTabPath}
          />
        }
        folderOpen={explorerOpen}
        folderDisabled={!project}
        onToggleFolder={onToggleExplorer}
        envInfoOpen={envInfoOpen}
        onToggleEnvInfo={project ? onToggleEnvInfo : undefined}
        terminalOpen={terminalOpen}
        onToggleTerminal={
          project ? () => setTerminalOpen((open) => !open) : undefined
        }
        project={project}
        onProjectActionError={setError}
      />

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {error && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive flex shrink-0 items-start justify-between gap-3 border-b px-3 py-2 text-[11px]">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
              <X className="size-3.5" />
            </button>
          </div>
          )}

          <div
            className="relative flex min-h-0 flex-1 overflow-hidden"
            data-workspace-editor-area
            data-split-file={splitFilePath ?? undefined}
          >
            <div
              className={cn(
                'min-h-0 min-w-0',
                splitFile || activeSurface === 'chat' ? 'flex' : 'hidden',
              )}
              style={{
                width: splitFile ? `${100 - splitPercent}%` : '100%',
              }}
              data-editor-group="chat"
            >
              {agentRuntimeV2 ? (
                <AgentRuntimeTranscript
                  taskId={taskId}
                  initialMessage={initialMessage}
                />
              ) : (
                <ChatSurface
                  taskId={taskId}
                  project={project}
                  initialMessage={initialMessage}
                />
              )}
            </div>

            {splitFile && (
              <WorkspaceSplitResizeHandle
                splitPercent={splitPercent}
                onResize={setSplitPercent}
              />
            )}

        {visibleFile && (
          <div
            className={cn(
              'min-h-0 min-w-0 flex-col',
              splitFile || activeSurface === 'file' ? 'flex' : 'hidden',
              splitFile && 'border-border/60 border-l',
            )}
            style={{ width: splitFile ? `${splitPercent}%` : '100%' }}
            data-editor-group="file"
            data-editor-file={visibleFile.path}
          >
            {visibleFile.language !== 'markdown' &&
              visibleFile.language !== 'html' && (
              <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
                <span className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
                  {visibleFile.path}
                </span>
                <div className="flex shrink-0 items-center gap-1 pl-2">
                  {saveNotice && (
                    <span className="text-muted-foreground text-[10px]">
                      {saveNotice}
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label="Save active file"
                    title="Save (Ctrl+S)"
                    className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-6 items-center justify-center rounded disabled:opacity-35"
                    disabled={
                      visibleFile.content === visibleFile.savedContent ||
                      savingPath !== null
                    }
                    onClick={() => void saveFile(visibleFile.path)}
                  >
                    {savingPath ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                  </button>
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1">
              {visibleFile.language === 'markdown' ||
              visibleFile.language === 'html' ? (
                <DocumentDualEditor
                  filePath={visibleFile.path}
                  language={visibleFile.language}
                  htmlPreviewBaseUrl={
                    visibleFile.language === 'html' && project
                      ? projectPreviewBaseUrl(project.id, visibleFile.path)
                      : undefined
                  }
                  content={visibleFile.content}
                  savedContent={visibleFile.savedContent}
                  onChange={(content) =>
                    setTabs((current) =>
                      current.map((file) =>
                        file.path === visibleFile.path
                          ? { ...file, content }
                          : file,
                      ),
                    )
                  }
                  onSave={() => void saveFile(visibleFile.path)}
                  saving={savingPath === visibleFile.path}
                  saveNotice={saveNotice}
                  visible={Boolean(splitFile) || activeSurface === 'file'}
                  initialMode="preview"
                />
              ) : (
                <Suspense
                  fallback={
                    <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-[12px]">
                      <LoaderCircle className="size-4 animate-spin" />
                      Loading editor…
                    </div>
                  }
                >
                  <CodeEditor
                    file={visibleFile}
                    visible={Boolean(splitFile) || activeSurface === 'file'}
                    onChange={(content) =>
                      setTabs((current) =>
                        current.map((file) =>
                          file.path === visibleFile.path
                            ? { ...file, content }
                            : file,
                        ),
                      )
                    }
                    onSave={() => void saveFile(visibleFile.path)}
                  />
                </Suspense>
              )}
            </div>
          </div>
        )}

        {activeSurface === 'file' && !visibleFile && (
          <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FileCode2 className="size-8 opacity-30" />
            <p className="text-[12px]">Select a file in Explorer.</p>
          </div>
        )}

            {draggedTabPath && (
              <WorkspaceSplitDropZone
                fileName={
                  tabs.find((file) => file.path === draggedTabPath)?.name ??
                  draggedTabPath
                }
                onDrop={(event) => {
                  const path =
                    event.dataTransfer.getData(FILE_TAB_DRAG_TYPE) ||
                    draggedTabPath
                  openInSplit(path)
                  setDraggedTabPath(null)
                }}
              />
            )}
          </div>

          {project && terminalOpen && (
            <TerminalPanel
              key={project.id}
              project={project}
              height={terminalHeight}
              onHeightChange={setTerminalHeight}
              onRequestClose={() => setTerminalOpen(false)}
            />
          )}
        </section>

        {project && (
          <ProjectFileTreePanel
            project={project}
            open={explorerOpen}
            activePath={activeSurface === 'file' ? selectedFilePath : null}
            loadingPath={loadingPath}
            onOpenFile={(entry) => void openFile(entry)}
          />
        )}

        {project && (
          <EnvironmentalInfoPanel
            project={project}
            taskId={taskId}
            open={envInfoOpen}
            onOpenTerminal={
              project ? () => setTerminalOpen(true) : undefined
            }
          />
        )}
      </div>
    </div>
  )
}

function WorkspaceSplitDropZone({
  fileName,
  onDrop,
}: {
  fileName: string
  onDrop: (event: DragEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      className="pointer-events-none absolute inset-0 z-40 flex justify-end bg-black/5"
      aria-hidden="true"
    >
      <div
        className="border-primary/60 bg-primary/10 pointer-events-auto flex h-full w-[46%] items-center justify-center border-2 border-dashed backdrop-blur-[1px]"
        data-split-drop-zone="right"
        onDragEnter={(event) => event.preventDefault()}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          event.preventDefault()
          onDrop(event)
        }}
      >
        <div className="bg-background/90 border-border/70 flex max-w-[240px] items-center gap-2 rounded-lg border px-3 py-2 shadow-lg">
          <Columns2 className="text-primary size-4 shrink-0" />
          <span className="min-w-0 text-[11px]">
            Open <strong className="font-medium">{fileName}</strong> beside Chat
          </span>
        </div>
      </div>
    </div>
  )
}

function WorkspaceSplitResizeHandle({
  splitPercent,
  onResize,
}: {
  splitPercent: number
  onResize: (percent: number) => void
}) {
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startPercent: number
    containerWidth: number
  } | null>(null)

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    document.documentElement.classList.remove('sidebar-resizing')
  }

  useEffect(
    () => () => document.documentElement.classList.remove('sidebar-resizing'),
    [],
  )

  return (
    <div className="relative z-30 w-0 shrink-0">
      <div
        role="separator"
        aria-label="Resize editor groups"
        aria-orientation="vertical"
        aria-valuemin={SPLIT_MIN_PERCENT}
        aria-valuemax={SPLIT_MAX_PERCENT}
        aria-valuenow={Math.round(splitPercent)}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        className="group/editor-split absolute inset-y-0 -left-2 z-30 w-4 cursor-col-resize touch-none"
        data-editor-split-resize
        onPointerDown={(event) => {
          if (event.button !== 0) return
          const containerWidth =
            event.currentTarget.parentElement?.parentElement
              ?.getBoundingClientRect().width ?? 1
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startPercent: splitPercent,
            containerWidth,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          document.documentElement.classList.add('sidebar-resizing')
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          const deltaPercent =
            ((event.clientX - drag.startX) / drag.containerWidth) * 100
          onResize(clampSplitPercent(drag.startPercent - deltaPercent))
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onResize(SPLIT_DEFAULT_PERCENT)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          onResize(
            clampSplitPercent(
              splitPercent + (event.key === 'ArrowLeft' ? 2 : -2),
            ),
          )
        }}
      >
        <div className="group-hover/editor-split:bg-primary/60 mx-auto h-full w-0.5 transition-colors" />
      </div>
    </div>
  )
}

function clampSplitPercent(percent: number): number {
  return Math.min(
    SPLIT_MAX_PERCENT,
    Math.max(SPLIT_MIN_PERCENT, percent),
  )
}

function projectPreviewBaseUrl(projectId: string, filePath: string): string {
  const directoryParts = filePath.replace(/\\/g, '/').split('/').slice(0, -1)
  const directory = directoryParts
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `brightcode-project://${encodeURIComponent(projectId)}/${directory ? `${directory}/` : ''}`
}
