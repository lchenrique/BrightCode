import { Component, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, Columns2, LoaderCircle, Rows3 } from 'lucide-react'
import { DiffView, DiffModeEnum } from '@git-diff-view/react'
import { useFileDiff } from '@/hooks/use-file-diff'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

import '@git-diff-view/react/styles/diff-view.css'
/**
 * Inline diff viewer for a single file inside the Environmental
 * Information panel. Renders a back button, split/unified toggle, and
 * a `@git-diff-view/react <DiffView>` with the unified-hunk feed from
 * the `useFileDiff` hook.
 */
export function FileDiffViewer({
  project,
  filePath,
  isUntracked,
  isDeleted,
  onBack,
}: {
  project: Project
  filePath: string
  isUntracked: boolean
  isDeleted: boolean
  onBack: () => void
}) {
  const { data, loading, error } = useFileDiff(project, filePath, isUntracked, isDeleted)
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub)

  const lang = useMemo(() => {
    const dot = filePath.lastIndexOf('.')
    if (dot < 0) return 'plaintext'
    const ext = filePath.slice(dot + 1).toLowerCase()
    return LANG_MAP[ext] ?? 'plaintext'
  }, [filePath])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <button
          type="button"
          aria-label="Back to changes"
          onClick={onBack}
          className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-7 items-center justify-center rounded-md"
          title="Back"
        >
          <ArrowLeft className="size-3.5" />
        </button>
        <span className="text-muted-foreground truncate font-mono text-[11px]" title={filePath}>
          {filePath}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <ModeButton
            active={mode === DiffModeEnum.SplitGitHub}
            onClick={() => setMode(DiffModeEnum.SplitGitHub)}
            label="Split view"
            icon={Columns2}
          />
          <ModeButton
            active={mode === DiffModeEnum.Unified}
            onClick={() => setMode(DiffModeEnum.Unified)}
            label="Unified view"
            icon={Rows3}
          />
        </div>
      </div>

      {/* Body */}
      <div className="diff-viewer-host min-h-0 flex-1 overflow-auto bg-background">
        {loading && (
          <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-[12px]">
            <LoaderCircle className="size-3.5 animate-spin" />
            Loading diff…
          </div>
        )}
        {error && (
          <div className="text-destructive px-3 py-2 text-[12px]">{error}</div>
        )}
        {!loading && !error && data && data.hunks.length > 0 && (
          <DiffViewErrorBoundary filePath={filePath}>
            <DiffView
              data={{
                oldFile: {
                  fileName: `a/${filePath}`,
                  fileLang: lang,
                  content: data.oldContent,
                },
                newFile: {
                  fileName: `b/${filePath}`,
                  fileLang: lang,
                  content: data.newContent,
                },
                hunks: data.hunks,
              }}
              diffViewMode={mode}
              diffViewTheme="dark"
              diffViewHighlight
            />
          </DiffViewErrorBoundary>
        )}
        {!loading && !error && data && data.hunks.length === 0 && (
          <div className="text-muted-foreground px-3 py-2 text-[12px]">
            No changes in this file.
          </div>
        )}
      </div>
    </div>
  )
}

function ModeButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean
  onClick: () => void
  label: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md transition-colors',
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-3.5" />
    </button>
  )
}

const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  lua: 'lua',
  r: 'r',
  dart: 'dart',
  vue: 'xml',
  svelte: 'xml',
}

/**
 * Catches the occasional `parseHunk` crash in `@git-diff-view/react` for
 * files with binary content or malformed diff hunks (e.g. .docx). Without
 * this, the whole React tree unmounts and the panel blanks out.
 */
class DiffViewErrorBoundary extends Component<
  { filePath: string; children: ReactNode },
  { hasError: boolean; message: string }
> {
  state = { hasError: false, message: '' }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message ?? 'Diff render failed' }
  }
  componentDidCatch() {
    // Swallowed — we already have a friendly message above.
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="text-muted-foreground px-3 py-3 text-[11px]">
          <p className="text-destructive mb-1 font-medium">
            Cannot render diff for {this.props.filePath}
          </p>
          <p>{this.state.message}</p>
          <p className="mt-2">
            The file may be binary, too large, or contain unsupported
            characters. Use the file editor for changes inside this file.
          </p>
        </div>
      )
    }
    return this.props.children
  }
}
