/**
 * MessageBubble + ErrorBubble + ToolCallList.
 *
 * Pure presentational. Receives a `Message` (see `./types`) and renders
 * the appropriate variant. Used by both the welcome screen and the
 * project view.
 */

import { useState } from 'react'
import { AlertCircle, ChevronRight, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type Message } from './types'
import { MarkdownRenderer } from './MarkdownRenderer'

export function MessageBubble({
  message,
  compact = false,
}: {
  message: Message
  /**
   * `true` when this bubble is rendered as the "text reply" that lives
   * BELOW an AssistantTurn. In that mode the model-name label and
   * tool-call list are suppressed — those are owned by the turn. Only
   * the text content (and the streaming-dot indicator if still
   * streaming) is shown, sitting tight against the turn above.
   */
  compact?: boolean
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-secondary/60 max-w-[85%] rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed">
          {message.content}
        </div>
      </div>
    )
  }

  if (message.role === 'error') {
    return <ErrorBubble message={message} />
  }

  if (message.role === 'tool') {
    const tc = message.toolCalls?.[0]
    const summary = message.toolResultSummary
    return (
      <div className="ml-1 flex flex-col gap-1">
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px]',
            message.toolError
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-border/60 bg-card/40 text-muted-foreground',
          )}
        >
          <Wrench className="size-3" />
          <span className="font-mono text-[11px]">{tc?.name}</span>
          {tc && (
            <code className="text-muted-foreground/80 max-w-[40ch] truncate font-mono text-[11px]">
              {summarizeArgs(tc.name, tc.input)}
            </code>
          )}
          <span className="ml-auto text-[11px] font-medium">
            {message.toolError
              ? 'failed'
              : summary && summary.length > 0
                ? summary
                : 'ok'}
          </span>
        </div>
      </div>
    )
  }

  // assistant — compact mode is the text reply that follows the turn.
  // No model label, no tool calls (those are in the turn). Just the
  // text content + a subtle streaming dot.
  if (compact) {
    const hasContent = Boolean(message.content)
    return (
      <div className="text-foreground/90 ml-1.5 -mt-1 text-[14px] leading-relaxed">
        {hasContent && <MarkdownRenderer content={message.content} />}
        {!hasContent && message.streaming && <span>…</span>}
        {message.streaming && hasContent && (
          <span className="bg-primary ml-1 inline-block h-1.5 w-1.5 translate-y-[-1px] animate-pulse rounded-full align-middle" />
        )}
      </div>
    )
  }

  // assistant — standalone (no turn above). Used for legacy code paths;
  // the new design always pairs assistant text with a turn.
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
        {message.model ?? 'assistant'}
        {message.streaming && (
          <span className="bg-primary ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full align-middle" />
        )}
      </div>
      {message.content && (
        <div className="text-foreground text-[14px] leading-relaxed">
          <MarkdownRenderer content={message.content} />
        </div>
      )}
      {message.toolCalls && message.toolCalls.length > 0 && (
        <ToolCallList toolCalls={message.toolCalls} />
      )}
    </div>
  )
}

function ToolCallList({
  toolCalls,
}: {
  toolCalls: Array<{ id: string; name: string; input: unknown }>
}) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {toolCalls.map((tc) => (
        <div
          key={tc.id}
          className="border-border/60 bg-card/40 text-muted-foreground flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px]"
        >
          <Wrench className="size-3" />
          <span className="font-mono text-[11px]">{tc.name}</span>
          <code className="text-muted-foreground/80 max-w-[50ch] truncate font-mono text-[11px]">
            {summarizeArgs(tc.name, tc.input)}
          </code>
        </div>
      ))}
    </div>
  )
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
  return JSON.stringify(args).slice(0, 80)
}

function ErrorBubble({ message }: { message: Message }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-4 py-3 text-[13px]">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="whitespace-pre-wrap">{message.content}</div>
          {message.errorDetails && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="text-destructive/80 hover:text-destructive mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', open && 'rotate-90')}
              />
              {open ? 'Hide' : 'Show'} technical details
            </button>
          )}
          {open && message.errorDetails && (
            <pre className="text-destructive/80 bg-destructive/5 mt-2 max-h-48 overflow-auto rounded-md p-2 font-mono text-[11px] leading-snug">
              {message.errorDetails}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}
