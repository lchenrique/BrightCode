/**
 * AssistantTurn — one iteration of the agent loop, presented the way
 * MiniMax Code shows it:
 *
 *   Thought 1 time(s), Used 1 tool(s)  ▸
 *   ┌─────────────────────────────────────────────────────┐
 *   │  </> Write File    ToolTimeline.tsx                 │
 *   │  🧠 Thinking process                                     │
 *   │  >_ Terminal       Get-ChildItem "..."                │
 *   │                                                         │
 *   │  Optional free-form assistant text                     │
 *   │  ─────────────────                                       │
 *   │  🤖 Filling in step by step...                          │
 *   └─────────────────────────────────────────────────────┘
 *
 * Header starts collapsed (matches MiniMax Code default). The body
 * always shows the timeline; the "Filling in step by step…"
 * indicator appears at the end when the turn is still streaming,
 * with a subtle shine animation on the header to signal activity.
 */

import { useEffect, useState } from 'react'
import {
  ChevronDown,
  Brain,
  Bot,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ToolTimelineItem, type ToolTimelineItem as ToolItem } from './ToolTimeline'
import type { Message } from './types'

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
  'Filling in step by step…',
  'Thinking…',
  'Reading the files…',
  'Writing…',
  'Targeting…',
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

export function AssistantTurn({
  assistant,
  toolMessages,
  streaming,
}: AssistantTurnProps) {
  // Default collapsed, matches MiniMax Code.
  const [open, setOpen] = useState(false)
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
      // Pending = no result yet AND we're still streaming.
      pending: streaming && !result,
    }
  })

  // Categorize tools for the header counters. The labels match the
  // MiniMax Code phrasing ("Viewed", "Edited", "Ran", "Searched").
  const viewed = items.filter((i) => i.name === 'read_file').length
  const edited = items.filter((i) =>
    i.name === 'write_file' || i.name === 'edit_file',
  ).length
  const commandCount = items.filter((i) => i.name === 'bash').length
  const searched = items.filter((i) => i.name === 'search_files').length
  const otherCount =
    items.length - viewed - edited - commandCount - searched

  // The "Thought N time(s)" badge — we count it as 1 per turn that
  // has any tool calls. Empty + still streaming also counts as 1.
  const thoughtCount = items.length > 0 || streaming ? 1 : 0

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
          )}
        >
          Thought {thoughtCount} time{thoughtCount === 1 ? '' : 's'}
        </span>
        {items.length > 0 && (
          <>
            <span className="text-muted-foreground/60">,</span>
            <span>Used {items.length} tool{items.length === 1 ? '' : 's'}</span>
          </>
        )}
      </button>

      {open && (
        <div className="border-border/40 bg-card/20 ml-1.5 flex flex-col gap-2 rounded-lg border py-2 pl-4 pr-3">
          {assistant.thinking && (
            <div className="border-border/30 text-muted-foreground/90 mb-1 max-h-60 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-[12px] font-mono">
              {assistant.thinking}
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

          {streaming && (
            <div className="text-muted-foreground/90 mt-1 flex items-center gap-2 text-[12.5px]">
              <Bot className="size-3.5 shrink-0" />
              <span
                key={phraseIndex}
                className="inline-block animate-[fadeInUp_0.35s_ease-out]"
              >
                {FILLING_PHRASES[phraseIndex]}
              </span>
            </div>
          )}
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
          />
        </div>
      )}
    </div>
  )
}

function SummaryLine({
  viewed,
  edited,
  commandCount,
  searched,
  otherCount,
}: {
  viewed: number
  edited: number
  commandCount: number
  searched: number
  otherCount: number
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
  return <span>{parts.join(' · ')}</span>
}
