/**
 * A single entry in the assistant's tool timeline.
 *
 * Renders as a vertical list row with a tool-specific icon, name, and
 * a short argument preview (file path, search query, etc). Mirrors the
 * MiniMax Code timeline look: monospace label, file path in monospace,
 * `failed` / `ok` / `n chars` summary on the right.
 */

import {
  BookOpen,
  Bot,
  Brain,
  Code,
  FileEdit,
  FileSearch,
  FileText,
  FolderSearch,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { AgentAvatar } from '@/components/ui/agent-avatar'
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
  /** True when this item is an agent delegation result. */
  isAgentResult?: boolean
  /** Display name of the agent that produced this result. */
  agentName?: string
  /** DiceBear avatar seed of the agent. */
  agentAvatarSeed?: string
}

export function ToolTimelineItem({ item }: { item: ToolTimelineItem }) {
  if (item.isAgentResult) {
    return (
      <div
        className={cn(
          'flex items-center gap-3 py-1.5 text-[13px]',
          item.errored && 'text-destructive',
        )}
      >
        {item.agentAvatarSeed ? (
          <AgentAvatar
            seed={item.agentAvatarSeed}
            size={16}
            className="ring-0"
          />
        ) : (
          <Bot className="text-muted-foreground size-4 shrink-0" />
        )}
        <span className="text-foreground/80 shrink-0 text-[12.5px] font-medium">
          {item.agentName ?? item.name}
        </span>
        <span className="text-muted-foreground/60 min-w-0 flex-1 truncate text-[12px]">
          {item.input && typeof item.input === 'object' && 'task' in item.input
            ? String((item.input as Record<string, unknown>).task ?? '').slice(0, 80)
            : ''}
        </span>
        <span
          className={cn(
            'shrink-0 text-[11.5px] tabular-nums',
            item.errored ? 'text-destructive' : 'text-muted-foreground',
          )}
          title={item.errored ? item.summary : undefined}
        >
          {item.errored
            ? truncateSummary(item.summary) || 'failed'
            : item.pending
              ? '…'
              : (item.summary ?? '')}
        </span>
      </div>
    )
  }

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
        {item.pending ? getPendingLabel(item.name) : getToolLabel(item.name)}
      </span>
      <code
        className="text-muted-foreground/80 min-w-0 flex-1 truncate font-mono text-[11.5px]"
        title={summarizeArgs(item.name, item.input)}
      >
        {summarizeArgs(item.name, item.input)}
      </code>
      <span
        className={cn(
          'shrink-0 text-[11.5px] tabular-nums',
          item.errored ? 'text-destructive' : 'text-muted-foreground',
        )}
        title={item.errored ? item.summary : undefined}
      >
        {item.errored
          ? truncateSummary(item.summary) || 'failed'
          : item.pending
            ? '…'
            : (item.summary ?? '')}
      </span>
    </div>
  )
}

function truncateSummary(summary: string | undefined): string {
  if (!summary) return ''
  // Drop any leading "Error: " prefix — the red color already signals failure.
  const cleaned = summary.replace(/^Error:\s*/i, '')
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned
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
    case 'list_skills':
    case 'read_skill':
    case 'read_skill_file':
      return BookOpen
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
    case 'list_skills':
      return 'Discover Skills'
    case 'read_skill':
      return 'Load Skill'
    case 'read_skill_file':
      return 'Read Skill File'
    case 'bash':
      return 'Terminal'
    default:
      return 'Thinking process'
  }
}

/**
 * In-progress label shown while the tool result has not landed yet. The
 * static `getToolLabel` is past-tense ("Read File") which reads as if the
 * work is done; the pending form uses a present participle to make it
 * clear the call is still running.
 */
function getPendingLabel(name: string): string {
  switch (name) {
    case 'read_file':
      return 'Reading'
    case 'write_file':
      return 'Writing'
    case 'edit_file':
      return 'Editing'
    case 'list_files':
      return 'Listing'
    case 'search_files':
      return 'Searching'
    case 'list_skills':
      return 'Discovering'
    case 'read_skill':
      return 'Loading'
    case 'read_skill_file':
      return 'Reading'
    case 'bash':
      return 'Running'
    default:
      return 'Working'
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
  if (name === 'list_skills') {
    return a.query ? String(a.query) : 'all available skills'
  }
  if (name === 'read_skill') {
    return String(a.skill ?? '')
  }
  if (name === 'read_skill_file') {
    return `${String(a.skill ?? '')} · ${String(a.path ?? '')}`
  }
  if (name === 'bash') {
    return String(a.command ?? '')
  }
  return JSON.stringify(args).slice(0, 80)
}

export { Brain }
