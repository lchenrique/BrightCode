import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  Code2,
  Eye,
  Columns2,
  Save,
  LoaderCircle,
  Check,
} from 'lucide-react'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const CodeEditor = lazy(() =>
  import('@/components/files/CodeEditor').then((module) => ({
    default: module.CodeEditor,
  })),
)

export type DocumentViewMode = 'code' | 'preview' | 'split'
export type PreviewableLanguage = 'markdown' | 'html'

export interface DocumentDualEditorProps {
  filePath: string
  language: PreviewableLanguage
  htmlPreviewBaseUrl?: string
  content: string
  savedContent: string
  onChange: (newContent: string) => void
  onSave: () => void
  saving?: boolean
  saveNotice?: string | null
  readOnly?: boolean
  visible?: boolean
  /** Controlled mode, used when the parent owns a unified toolbar. */
  mode?: DocumentViewMode
  onModeChange?: (mode: DocumentViewMode) => void
  showToolbar?: boolean
  /** Initial mode. Defaults to formatted preview for quick reading. */
  initialMode?: DocumentViewMode
}

export function DocumentDualEditor({
  filePath,
  language,
  htmlPreviewBaseUrl,
  content,
  savedContent,
  onChange,
  onSave,
  saving = false,
  saveNotice = null,
  readOnly = false,
  visible = true,
  mode: controlledMode,
  onModeChange,
  showToolbar = true,
  initialMode = 'preview',
}: DocumentDualEditorProps) {
  const [internalMode, setInternalMode] =
    useState<DocumentViewMode>(initialMode)
  const mode = controlledMode ?? internalMode
  const isDirty = content !== savedContent
  const previewContent = useMemo(
    () =>
      language === 'markdown'
        ? markdownBody(content)
        : withHtmlPreviewBase(content, htmlPreviewBaseUrl),
    [content, htmlPreviewBaseUrl, language],
  )
  const changeMode = (nextMode: DocumentViewMode) => {
    if (controlledMode === undefined) setInternalMode(nextMode)
    onModeChange?.(nextMode)
  }

  useEffect(() => {
    if (!visible || readOnly) return
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
        return
      }
      event.preventDefault()
      if (isDirty && !saving) onSave()
    }
    window.addEventListener('keydown', handleSaveShortcut)
    return () => window.removeEventListener('keydown', handleSaveShortcut)
  }, [isDirty, onSave, readOnly, saving, visible])

  return (
    <div
      className="bg-background flex h-full w-full flex-col overflow-hidden"
      data-document-editor
      data-document-language={language}
      data-markdown-editor={language === 'markdown' ? '' : undefined}
      data-html-editor={language === 'html' ? '' : undefined}
      data-view-mode={mode}
    >
      {/* Markdown Mode & Actions Bar */}
      {showToolbar && (
      <div className="border-border/60 bg-card/30 flex h-9 shrink-0 items-center justify-between gap-3 border-b px-2.5 text-[11.5px]">
        {/* Mode Switcher Segmented Buttons */}
        <div className="flex min-w-0 items-center gap-2.5">
          <DocumentModeSwitcher
            mode={mode}
            onModeChange={changeMode}
            previewLabel={language === 'html' ? 'Preview' : 'Formatted'}
            previewTitle={
              language === 'html'
                ? 'Preview HTML document'
                : 'View formatted Markdown'
            }
          />
          <span
            className="text-muted-foreground hidden min-w-0 truncate font-mono text-[10px] xl:block"
            title={filePath}
          >
            {filePath}
          </span>
        </div>

        {/* Right Status & Save */}
        <div className="flex items-center gap-2">
          {saveNotice && (
            <span className="text-emerald-400 flex items-center gap-1 text-[11px]">
              <Check className="size-3" />
              {saveNotice}
            </span>
          )}

          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={onSave}
              disabled={!isDirty || saving}
              className="h-6 gap-1 px-2 text-[11px]"
            >
              {saving ? (
                <LoaderCircle className="size-3 animate-spin" />
              ) : (
                <Save className="size-3" />
              )}
              <span>{isDirty ? 'Save (Ctrl+S)' : 'Saved'}</span>
            </Button>
          )}
        </div>
      </div>
      )}

      {/* Editor Body */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Code Mode */}
        {mode === 'code' && (
          <Suspense
            fallback={
              <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-[12px]">
                <LoaderCircle className="size-4 animate-spin" />
                Loading Code Editor…
              </div>
            }
          >
            <CodeEditor
              file={{
                path: filePath,
                content,
                language,
              }}
              visible={mode === 'code'}
              readOnly={readOnly}
              onChange={onChange}
              onSave={onSave}
            />
          </Suspense>
        )}

        {/* Formatted Preview Mode */}
        {mode === 'preview' && (
          <DocumentPreview
            language={language}
            content={previewContent}
            filePath={filePath}
            spacious
          />
        )}

        {/* Split View Mode */}
        {mode === 'split' && (
          <div className="flex h-full w-full overflow-hidden">
            {/* Left: Code Editor */}
            <div className="h-full w-1/2 min-w-0">
              <Suspense
                fallback={
                  <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-[12px]">
                    <LoaderCircle className="size-4 animate-spin" />
                    Loading Code Editor…
                  </div>
                }
              >
                <CodeEditor
                  file={{
                    path: filePath,
                    content,
                    language,
                  }}
                  visible={mode === 'split'}
                  readOnly={readOnly}
                  onChange={onChange}
                  onSave={onSave}
                />
              </Suspense>
            </div>

            {/* Right: Live Rendered Markdown */}
            <div className="border-border/60 bg-card/10 h-full w-1/2 min-w-0 border-l">
              <DocumentPreview
                language={language}
                content={previewContent}
                filePath={filePath}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function DocumentModeSwitcher({
  mode,
  onModeChange,
  compact = false,
  previewLabel = 'Formatted',
  previewTitle = 'View formatted Markdown',
}: {
  mode: DocumentViewMode
  onModeChange: (mode: DocumentViewMode) => void
  compact?: boolean
  previewLabel?: string
  previewTitle?: string
}) {
  const modes = [
    {
      id: 'code' as const,
      label: 'Code',
      title: 'Edit Markdown source',
      icon: Code2,
    },
    {
      id: 'preview' as const,
      label: previewLabel,
      title: previewTitle,
      icon: Eye,
    },
    {
      id: 'split' as const,
      label: 'Split',
      title: 'Edit and preview side by side',
      icon: Columns2,
    },
  ]

  return (
    <div
      className="border-border/60 bg-secondary/40 inline-flex shrink-0 items-center rounded-md border p-0.5"
      role="group"
      aria-label="Markdown view"
    >
      {modes.map(({ id, label, title, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onModeChange(id)}
          aria-pressed={mode === id}
          title={title}
          className={cn(
            'inline-flex items-center rounded px-2 py-0.5 font-medium transition-colors',
            compact ? 'gap-1 text-[11px]' : 'gap-1.5',
            mode === id
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" />
          <span>{label}</span>
        </button>
      ))}
    </div>
  )
}

function DocumentPreview({
  language,
  content,
  filePath,
  spacious = false,
}: {
  language: PreviewableLanguage
  content: string
  filePath: string
  spacious?: boolean
}) {
  if (language === 'html') {
    return (
      <div className="h-full w-full overflow-hidden bg-white">
        <iframe
          title={`Preview of ${filePath}`}
          srcDoc={content}
          sandbox="allow-scripts"
          className="h-full w-full border-0 bg-white"
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'h-full w-full overflow-y-auto',
        spacious ? 'p-6' : 'p-5',
      )}
    >
      <div className="mx-auto max-w-4xl text-[13px]">
        <MarkdownRenderer content={content || '*Empty markdown document*'} />
      </div>
    </div>
  )
}

function markdownBody(content: string): string {
  const frontmatter = content.match(
    /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  )
  return frontmatter?.[1] ?? content
}

function withHtmlPreviewBase(content: string, baseUrl?: string): string {
  if (!baseUrl) return content

  const baseTag = `<base href="${escapeHtmlAttribute(baseUrl)}">`
  const head = /<head(?:\s[^>]*)?>/i
  if (head.test(content)) {
    return content.replace(head, (match) => `${match}${baseTag}`)
  }

  const html = /<html(?:\s[^>]*)?>/i
  if (html.test(content)) {
    return content.replace(html, (match) => `${match}<head>${baseTag}</head>`)
  }

  return `${baseTag}${content}`
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
