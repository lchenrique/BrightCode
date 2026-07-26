import {
  FileCode2,
  LoaderCircle,
  Save,
  X,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ChatSurface } from '@/components/chat/ChatSurface'
import {
  ProjectFileIcon,
  ProjectFileTreePanel,
  type ProjectFileEntry,
} from '@/components/files/ProjectFileTreePanel'
import { ViewTopBar } from '@/components/layout/ViewTopBar'
import { notifyProjectFilesChanged } from '@/lib/projects/file-events'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

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
  onSelectFile,
  onCloseFile,
}: {
  tabs: OpenFile[]
  activeSurface: 'chat' | 'file'
  selectedFilePath: string | null
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
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
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={file.path}
            className={cn(
              'group relative flex h-full max-w-[170px] min-w-[104px] shrink-0 items-center gap-1.5 border-l px-2.5 text-[11px]',
              active
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
            onClick={() => onSelectFile(file.path)}
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
}: {
  title: string
  taskId: string
  project: Project | null
  initialMessage: string | null
  explorerOpen: boolean
  onToggleExplorer?: () => void
}) {
  const [tabs, setTabs] = useState<OpenFile[]>([])
  const [activeSurface, setActiveSurface] = useState<'chat' | 'file'>('chat')
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [savingPath, setSavingPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  const selectedFile =
    tabs.find((file) => file.path === selectedFilePath) ?? null

  useEffect(() => {
    setTabs([])
    setActiveSurface('chat')
    setSelectedFilePath(null)
    setError(null)
    setSaveNotice(null)
  }, [project?.id, taskId])

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
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoadingPath((current) => (current === entry.path ? null : current))
      }
    },
    [project, tabs],
  )

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
      if (selectedFilePath === path) {
        const nextFile = nextTabs[Math.min(index, nextTabs.length - 1)] ?? null
        setSelectedFilePath(nextFile?.path ?? null)
        if (!nextFile) setActiveSurface('chat')
      }
    },
    [selectedFilePath, tabs],
  )

  const saveSelectedFile = useCallback(async () => {
    if (!selectedFile || !project || savingPath) return
    const api = window.electronAPI?.workspace
    if (!api) {
      setError('Saving is available in the desktop app.')
      return
    }

    const contentBeingSaved = selectedFile.content
    setSavingPath(selectedFile.path)
    setError(null)
    try {
      const result = await api.writeFile(
        project.id,
        selectedFile.path,
        contentBeingSaved,
      )
      if (!result.ok) {
        setError(result.error)
        return
      }
      setTabs((current) =>
        current.map((file) =>
          file.path === selectedFile.path
            ? { ...file, savedContent: contentBeingSaved }
            : file,
        ),
      )
      setSaveNotice(`${selectedFile.name} saved`)
      notifyProjectFilesChanged(project.id, selectedFile.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingPath(null)
    }
  }, [project, savingPath, selectedFile])

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
            onSelectFile={(path) => {
              setSelectedFilePath(path)
              setActiveSurface('file')
            }}
            onCloseFile={closeFile}
          />
        }
        folderOpen={explorerOpen}
        folderDisabled={!project}
        onToggleFolder={onToggleExplorer}
        progressOpen={project ? explorerOpen : undefined}
        onToggleProgress={onToggleExplorer}
        panelLabel="Toggle project file explorer"
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
          className={cn(
            'min-h-0 flex-1',
            activeSurface === 'chat' ? 'flex' : 'hidden',
          )}
        >
          <ChatSurface
            taskId={taskId}
            project={project}
            initialMessage={initialMessage}
          />
        </div>

        {selectedFile && (
          <div
            className={cn(
              'min-h-0 flex-1 flex-col',
              activeSurface === 'file' ? 'flex' : 'hidden',
            )}
          >
            <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
              <span className="text-muted-foreground min-w-0 truncate font-mono text-[10px]">
                {selectedFile.path}
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
                    selectedFile.content === selectedFile.savedContent ||
                    savingPath !== null
                  }
                  onClick={() => void saveSelectedFile()}
                >
                  {savingPath ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1">
              <Suspense
                fallback={
                  <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-[12px]">
                    <LoaderCircle className="size-4 animate-spin" />
                    Loading editor…
                  </div>
                }
              >
                <CodeEditor
                  file={selectedFile}
                  visible={activeSurface === 'file'}
                  onChange={(content) =>
                    setTabs((current) =>
                      current.map((file) =>
                        file.path === selectedFile.path
                          ? { ...file, content }
                          : file,
                      ),
                    )
                  }
                  onSave={() => void saveSelectedFile()}
                />
              </Suspense>
            </div>
          </div>
        )}

        {activeSurface === 'file' && !selectedFile && (
          <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <FileCode2 className="size-8 opacity-30" />
            <p className="text-[12px]">Select a file in Explorer.</p>
          </div>
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
      </div>
    </div>
  )
}
