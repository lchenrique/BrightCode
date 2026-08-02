import { useEffect, useMemo, useState } from 'react'
import {
  FileCode2,
  Folder,
  LoaderCircle,
  MessageSquare,
  Search,
} from 'lucide-react'
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useProjects } from '@/hooks/use-projects'
import { useTasks } from '@/hooks/use-tasks'

type IndexedFile = {
  projectId: string
  projectLabel: string
  path: string
  name: string
}

type SearchResult =
  | { kind: 'project'; id: string; title: string; detail: string }
  | {
      kind: 'task'
      id: string
      projectId: string | null
      title: string
      detail: string
    }
  | {
      kind: 'file'
      projectId: string
      path: string
      name: string
      title: string
      detail: string
    }

export function SearchDialog({
  open,
  onOpenChange,
  onSelectProject,
  onSelectTask,
  onSelectFile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectProject: (projectId: string) => void
  onSelectTask: (taskId: string) => void
  onSelectFile: (file: {
    projectId: string
    path: string
    name: string
  }) => void
}) {
  const projects = useProjects()
  const tasks = useTasks()
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<IndexedFile[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)

  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }

    const api = window.electronAPI?.workspace
    if (!api || projects.length === 0) {
      setFiles([])
      return
    }

    let cancelled = false
    setLoadingFiles(true)
    void Promise.all(
      projects.map(async (project) => {
        const result = await api.listTree(project.id)
        if (!result.ok) return []
        return result.entries
          .filter((entry) => !entry.isDir)
          .map((entry) => ({
            projectId: project.id,
            projectLabel: project.label,
            path: entry.path,
            name: entry.name,
          }))
      }),
    )
      .then((groups) => {
        if (!cancelled) setFiles(groups.flat())
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, projects])

  const results = useMemo<SearchResult[]>(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const matches = (...values: string[]) =>
      !normalized ||
      values.some((value) => value.toLocaleLowerCase().includes(normalized))

    const projectResults: SearchResult[] = projects
      .filter((project) => matches(project.label, project.path))
      .map((project) => ({
        kind: 'project',
        id: project.id,
        title: project.label,
        detail: project.path,
      }))

    const taskResults: SearchResult[] = tasks
      .filter((task) => matches(task.title))
      .map((task) => ({
        kind: 'task',
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        detail:
          projects.find((project) => project.id === task.projectId)?.label ??
          'Conversation',
      }))

    const fileResults: SearchResult[] = files
      .filter((file) => matches(file.name, file.path, file.projectLabel))
      .slice(0, normalized ? 60 : 12)
      .map((file) => ({
        kind: 'file',
        projectId: file.projectId,
        path: file.path,
        name: file.name,
        title: file.name,
        detail: `${file.projectLabel} · ${file.path}`,
      }))

    return [...taskResults, ...projectResults, ...fileResults].slice(0, 80)
  }, [files, projects, query, tasks])

  const choose = (result: SearchResult) => {
    onOpenChange(false)
    if (result.kind === 'project') onSelectProject(result.id)
    else if (result.kind === 'task') onSelectTask(result.id)
    else {
      onSelectFile({
        projectId: result.projectId,
        path: result.path,
        name: result.name,
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[18%] flex max-w-2xl translate-y-0 flex-col overflow-hidden p-0"
        style={{ height: '68vh' }}
      >
        <div className="border-border/60 flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations, projects and files..."
            aria-label="Search BrightCode"
            className="h-11 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          {loadingFiles && (
            <LoaderCircle className="text-muted-foreground size-3.5 animate-spin" />
          )}
          <DialogCloseButton />
        </div>

        <DialogTitle className="sr-only">Search BrightCode</DialogTitle>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="text-muted-foreground flex h-32 items-center justify-center text-[12px]">
              {loadingFiles ? 'Indexing project files…' : 'No results found.'}
            </div>
          ) : (
            results.map((result) => {
              const Icon =
                result.kind === 'task'
                  ? MessageSquare
                  : result.kind === 'project'
                    ? Folder
                    : FileCode2
              return (
                <button
                  key={
                    result.kind === 'file'
                      ? `file:${result.projectId}:${result.path}`
                      : `${result.kind}:${result.id}`
                  }
                  type="button"
                  className="hover:bg-accent/60 flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left"
                  onClick={() => choose(result)}
                >
                  <span className="bg-secondary/70 flex size-7 shrink-0 items-center justify-center rounded-md">
                    <Icon className="text-muted-foreground size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium">
                      {result.title}
                    </span>
                    <span className="text-muted-foreground block truncate text-[10px]">
                      {result.detail}
                    </span>
                  </span>
                  <span className="text-muted-foreground/60 shrink-0 text-[9px] uppercase">
                    {result.kind}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
