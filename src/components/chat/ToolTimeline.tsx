/**
 * A single entry in the assistant's tool timeline.
 *
 * Renders as a vertical list row with a tool-specific icon, name, and
 * a short argument preview (file path, search query, etc). Mirrors the
 * MiniMax Code timeline look: monospace label, file path in monospace,
 * `failed` / `ok` / `n chars` summary on the right.
 */

import {
  Brain,
  Code,
  FileEdit,
  FileSearch,
  FileText,
  FolderSearch,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ToolTimelineItem {
  id: string
  name: string
  input?: unknown
  /** Free-form summary (e.g. "1 dir · 0 files", "324 bytes written"). */
  summary?: string
  /** True if the tool call errored. */
  errored?: boolean
  /** True while the tool call is still running (before the result lands). */
  pending?: boolean
}

export function ToolTimelineItem({ item }: { item: ToolTimelineItem }) {
  const Icon = getToolIcon(item.name)
  return (
    <div
      className={cn(
        'flex items-center gap-3 py-1.5 text-[13px]',
        item.errored && 'text-destructive',
      )}
    >
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <span className="text-foreground/80 shrink-0 text-[12.5px] font-medium">
        {getToolLabel(item.name)}
      </span>
      <code
        className="text-muted-foreground/80 min-w-0 flex-1 truncate font-mono text-[11.5px]"
        title={summarizeArgs(item.name, item.input)}
      >
        {summarizeArgs(item.name, item.input)}
      </code>
      <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums">
        {item.errored
          ? 'failed'
          : item.pending
            ? '…'
            : (item.summary ?? '')}
      </span>
    </div>
  )
}

function getToolIcon(name: string) {
  switch (name) {
    case 'read_file':
      return FileText
    case 'write_file':
      return Code
    case 'edit_file':
      return FileEdit
    case 'list_files':
      return FolderSearch
    case 'search_files':
      return FileSearch
    case 'bash':
      return TerminalSquare
    default:
      return Wrench
  }
}

function getToolLabel(name: string): string {
  switch (name) {
    case 'read_file':
      return 'Read File'
    case 'write_file':
      return 'Write File'
    case 'edit_file':
      return 'Edit File'
    case 'list_files':
      return 'List Files'
    case 'search_files':
      return 'Search Files'
    case 'bash':
      return 'Terminal'
    default:
      return 'Thinking process'
  }
}

function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const a = args as Record<string, unknown>
  if (name === 'read_file' || name === 'write_file' || name === 'edit_file') {
    return String(a.path ?? '')
  }
  if (name === 'list_files') {
    return String(a.path ?? '.') + (a.recursive ? ' (recursive)' : '')
  }
  if (name === 'search_files') {
    return `"${a.query}" in ${a.path ?? '.'}`
  }
  if (name === 'bash') {
    return String(a.command ?? '')
  }
  return JSON.stringify(args).slice(0, 80)
}

export { Brain }
