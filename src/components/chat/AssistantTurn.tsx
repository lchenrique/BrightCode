/**
 * AssistantTurn — one iteration of the agent loop, presented the way
 * MiniMax Code shows it:
 *
 *   Thought 1 time(s), Used 1 tool(s)  ▸
 *   ┌─────────────────────────────────────────────────────┐
 *   │  Write File      ToolTimeline.tsx                     │
 *   │  Thinking process                                     │
 *   │  Terminal        Get-ChildItem "..."                  │
 *   │                                                     │
 *   │  Optional free-form assistant text                   │
 *   │  ─────────────────                                   │
 *   │  Filling in step by step...                          │
 *   └─────────────────────────────────────────────────────┘
 *
 * Header starts collapsed (matches MiniMax Code default). The body
 * always shows the timeline; the "Filling in step by step…"
 * indicator appears at the end when the turn is still streaming,
 * with a subtle shine animation on the header to signal activity.
 */

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Brain,
  Bot,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToolTimelineItem, type ToolTimelineItem as ToolItem } from './ToolTimeline'
import type { Message } from './types'
import { MarkdownRenderer } from './MarkdownRenderer'

/**
 * Phrases the bot cycles through while the turn is still streaming. Order
 * is hand-picked to roughly match what the agent is doing at each moment
 * ("Reading the files…" when reads cluster, "Writing…" near edits, etc.)
 * so the label has a chance of being accurate. Mirrors the rotating
 * status line MiniMax Code shows at the bottom of an active turn
 * ("Filling in step by step…", "Targeting…", "Compacting context…",
 * "Almost there…", etc.). The last entry "Almost there…" is for turns
 * that take unusually long. The cycle goes 0 → 1 → … → 6 → 0, so we
 * naturally revisit the opener and never stall on the final one.
 *
 * Each phrase is wrapped in the same `key` to trigger the fadeInUp
 * keyframe in index.css, so swaps look intentional instead of a janky
 * text jump.
 */
const FILLING_PHRASES = [
  'Analyzing the request…',
  'Planning the next step…',
  'Preparing tool calls…',
  'Checking the project…',
  'Working step by step…',
  'Almost there…',
] as const

const PHRASE_INTERVAL_MS = 3500

export interface AssistantTurnProps {
  /** The assistant message that starts the turn (with `toolCalls`). */
  assistant: Message
  /** The tool messages that follow, in order. */
  toolMessages: Message[]
  /** When true, shows the "Filling in step by step..." indicator and
   *  the shine animation on the header. */
  streaming?: boolean
}

function AssistantTurnComponent({
  assistant,
  toolMessages,
  streaming,
}: AssistantTurnProps) {
  // Reasoning stays compact by default, including the active turn. Users can
  // expand it without having every new turn take over the transcript.
  const [open, setOpen] = useState(false)
  const thinkingScrollRef = useRef<HTMLDivElement>(null)
  const followThinkingRef = useRef(true)
  // Phrase index for the "Filling in step by step…" footer. Only advances
  // while the turn is streaming; resets to 0 when streaming stops so a
  // re-expanded turn shows the first phrase instead of a random one.
  const [phraseIndex, setPhraseIndex] = useState(0)

  useEffect(() => {
    if (!streaming) {
      setPhraseIndex(0)
      return
    }
    const id = window.setInterval(() => {
      setPhraseIndex((i) => (i + 1) % FILLING_PHRASES.length)
    }, PHRASE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [streaming])

  useLayoutEffect(() => {
    const node = thinkingScrollRef.current
    if (!node || !open || !streaming || !followThinkingRef.current) return
    node.scrollTop = node.scrollHeight
  }, [assistant.thinking, open, streaming])

  // Build the timeline from the assistant's `toolCalls` (authoritative)
  // merged with the tool result summaries from `toolMessages`. We index
  // by `tc.id` so the order matches the assistant's call order.
  const tcById = new Map<string, Message>()
  for (const tm of toolMessages) {
    const id = tm.toolCalls?.[0]?.id
    if (id) tcById.set(id, tm)
  }

  const items: ToolItem[] = (assistant.toolCalls ?? []).map((tc) => {
    const result = tcById.get(tc.id)
    return {
      id: tc.id,
      name: tc.name,
      input: tc.input,
      summary: result?.toolResultSummary,
      errored: result?.toolError,
      toolStopped: result?.toolStopped,
      // Pending = no result yet AND we're still streaming.
      pending: streaming && !result,
      isAgentResult: result?.isAgentResult,
      agentName: result?.agentName,
      agentAvatarSeed: result?.agentAvatarSeed,
      agentThinking: result?.agentThinking,
    }
  })

  // The text-generation phase is over once the assistant message has
  // committed content (the for-await loop in ChatSurface finishes text
  // streaming before it dispatches tool calls). At that point the global
  // `streaming` flag stays true (the agent loop is still running) but
  // the generic "Almost there…" / "Working step by step…" phrases are
  // misleading — the model has already emitted its words. Hide them
  // until either tool work begins (pending items > 0) or a new round
  // of text comes in. Without this, the user sees the cycling phrase
  // stack up after every model answer.
  const hasFinishedText = assistant.content.trim().length > 0
  const hasPendingTool = items.some((item) => item.pending)
  const showWorkingStatus = streaming && (assistant.streaming || !hasFinishedText || hasPendingTool)

  // Categorize tools for the header counters. The labels match the
  // MiniMax Code phrasing ("Viewed", "Edited", "Ran", "Searched").
  const successfulItems = items.filter((item) => !item.errored)
  const failedCount = items.filter((item) => item.errored).length
  const viewed = successfulItems.filter((i) => i.name === 'read_file').length
  const edited = successfulItems.filter((i) =>
    i.name === 'write_file' || i.name === 'edit_file',
  ).length
  const commandCount = successfulItems.filter((i) => i.name === 'bash').length
  const searched = successfulItems.filter((i) => i.name === 'search_files').length
  const otherCount =
    successfulItems.length - viewed - edited - commandCount - searched

  // The "Thought N time(s)" badge — we count it as 1 per turn that
  // has any tool calls. Empty + still streaming also counts as 1.
  // A user-stopped turn gets a distinct "Stopped" badge.
  const thoughtCount = assistant.thinking || items.length > 0 || streaming ? 1 : 0
  const workingPhrase = getWorkingPhrase(items, phraseIndex)

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-[12.5px] font-medium transition-colors',
          'text-muted-foreground hover:text-foreground/90',
        )}
      >
        {open ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <span
          className={cn(
            'transition-colors',
            streaming &&
              'bg-gradient-to-r from-muted-foreground via-foreground/80 to-muted-foreground bg-[length:200%_100%] bg-clip-text text-transparent animate-[shine_2s_linear_infinite]',
            assistant.stopped && 'text-muted-foreground/80',
          )}
        >
          {streaming
            ? 'Thinking…'
            : assistant.stopped
              ? 'Stopped by user'
              : `Thought ${thoughtCount} time${thoughtCount === 1 ? '' : 's'}`}
        </span>
        {items.length > 0 && (
          <>
            <span className="text-muted-foreground/60">,</span>
            <span>
              {streaming ? 'Using' : 'Used'} {items.length} tool
              {items.length === 1 ? '' : 's'}
            </span>
          </>
        )}
      </button>

      {open && (
        <div className="border-border/40 bg-card/20 ml-1.5 flex flex-col gap-2 rounded-lg border py-2 pl-4 pr-3">
          {assistant.thinking && (
            <div
              ref={thinkingScrollRef}
              onScroll={(event) => {
                const node = event.currentTarget
                followThinkingRef.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 48
              }}
              className="border-border/30 text-muted-foreground/90 mb-1 max-h-60 overflow-y-auto rounded border p-2.5 text-[12.5px]"
            >
              <MarkdownRenderer content={assistant.thinking} />
            </div>
          )}
          {items.length === 0 && !assistant.thinking ? (
            <div className="text-muted-foreground/80 flex items-center gap-2 text-[12.5px]">
              <Brain className="size-3.5" />
              <span>Thinking process</span>
            </div>
          ) : (
            items.map((it) => <ToolTimelineItem key={it.id} item={it} />)
          )}

          {/* Footer: bot avatar + cycling loading phrase. Mirrors the
              MiniMax Code look (small bot icon on the left, then the
              loading text). The `key` on the span forces a remount on
              every phrase change so the fadeInUp keyframe replays and
              the swap doesn't look like a text jump. The text response
              itself is rendered as a separate MessageBubble BELOW the
              turn (see MessageList) — the turn only owns the thinking
              + tool execution, not the final text. */}

          {showWorkingStatus && (
            <WorkingStatus phrase={workingPhrase} />
          )}
        </div>
      )}

      {/* When collapsed, keep the same animated bot visible below the
          summary. This replaces the old detached "..." loader and avoids
          introducing a second mascot outside the active turn. */}
      {!open && showWorkingStatus && (
        <div className="ml-5">
          <WorkingStatus phrase={workingPhrase} />
        </div>
      )}

      {/* Sub-counters (Viewed/Edited/Ran/Searched) — only show when collapsed
          and the turn has a mix of categories, so the user has a sense of
          what happened without expanding. Hidden when streaming (the shine
          animation is doing the signaling). */}
      {!open && items.length > 0 && !streaming && (
        <div className="text-muted-foreground/80 ml-5 text-[11.5px]">
          <SummaryLine
            viewed={viewed}
            edited={edited}
            commandCount={commandCount}
            searched={searched}
            otherCount={otherCount}
            failedCount={failedCount}
          />
        </div>
      )}
    </div>
  )
}

function sameMessages(previous: Message[], next: Message[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((message, index) => message === next[index])
  )
}

export const AssistantTurn = memo(
  AssistantTurnComponent,
  (previous, next) =>
    previous.assistant === next.assistant &&
    previous.streaming === next.streaming &&
    sameMessages(previous.toolMessages, next.toolMessages),
)

function getWorkingPhrase(items: ToolItem[], phraseIndex: number): string {
  const activeItems = items.filter((item) => item.pending)
  const names = new Set(activeItems.map((item) => item.name))

  if (activeItems.length > 1) return `Running ${activeItems.length} tools in parallel…`
  if (names.has('write_file') || names.has('edit_file')) return 'Writing files…'
  if (names.has('read_file')) return 'Reading files…'
  if (names.has('search_files')) return 'Searching the project…'
  if (names.has('list_skills')) return 'Discovering skills…'
  if (names.has('read_skill') || names.has('read_skill_file')) {
    return 'Loading skill instructions…'
  }
  if (names.has('bash')) return 'Running commands…'

  return FILLING_PHRASES[phraseIndex] ?? FILLING_PHRASES[0]
}

function WorkingStatus({ phrase }: { phrase: string }) {
  return (
    <div
      className="text-muted-foreground/90 mt-1 flex items-center gap-2 text-[12.5px]"
      role="status"
      aria-live="polite"
      aria-label={`Agent is working: ${phrase}`}
    >
      <Bot className="assistant-working-bot size-3.5 shrink-0" aria-hidden="true" />
      <span
        key={phrase}
        className="inline-block animate-[fadeInUp_0.35s_ease-out]"
      >
        {phrase}
      </span>
    </div>
  )
}

function SummaryLine({
  viewed,
  edited,
  commandCount,
  searched,
  otherCount,
  failedCount,
}: {
  viewed: number
  edited: number
  commandCount: number
  searched: number
  otherCount: number
  failedCount: number
}) {
  const parts: string[] = []
  if (viewed) parts.push(`Viewed ${viewed} file${viewed === 1 ? '' : 's'}`)
  if (edited) parts.push(`Edited ${edited} file${edited === 1 ? '' : 's'}`)
  if (commandCount)
    parts.push(`Ran ${commandCount} command${commandCount === 1 ? '' : 's'}`)
  if (searched)
    parts.push(`Searched ${searched} time${searched === 1 ? '' : 's'}`)
  if (otherCount)
    parts.push(`${otherCount} other${otherCount === 1 ? '' : 's'}`)
  if (failedCount)
    parts.push(`Failed ${failedCount} tool${failedCount === 1 ? '' : 's'}`)
  return <span>{parts.join(' · ')}</span>
}
