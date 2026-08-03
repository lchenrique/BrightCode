/**
 * MentionMenu — the `@`-triggered picker for files and agents.
 *
 * Pattern (OpenCode / Orkas / OpenChamber style):
 *   - Header with item count
 *   - Two sections (Files, Agents) with a small caps label
 *   - Each row: icon/avatar + name (highlighted matched chars) + path
 *     (file) or description (agent)
 *   - Selected row is highlighted; mouse hover sets the active row
 *   - Footer with navigation hints
 *
 * Recently-used mentions (last 5) are kept in localStorage by the parent
 * and passed in via `recents`. When the query is empty, recents show
 * first in a separate section so the user can re-pick a file they just
 * referenced without retyping.
 */

import { forwardRef, type ReactNode } from 'react'
import { AtSign, CornerDownLeft, FileCode } from 'lucide-react'
import { AgentAvatar } from '@/components/ui/agent-avatar'
import { fuzzyFilter, highlightCandidate, type FuzzyMatch } from './fuzzy'

export interface MentionFileItem {
  /** Stable id — typically the workspace-relative path. */
  id: string
  /** Display label — usually the basename. */
  label: string
  /** Optional parent directory, shown as the secondary line. */
  hint?: string
}

export interface MentionAgentItem {
  id: string
  name: string
  /** Used by the DiceBear avatar; same seed = same robot. */
  avatarSeed: string
  description?: string
}

export interface MentionItem {
  /** Synthetic id for keyboard nav. Combines kind + source id. */
  key: string
  kind: 'recent' | 'file' | 'agent'
  file?: MentionFileItem
  agent?: MentionAgentItem
  /** Display label, used for fuzzy matching. */
  label: string
  /** Secondary line, used for fuzzy matching too. */
  hint?: string
}

export interface MentionMenuProps {
  files: MentionFileItem[]
  agents: MentionAgentItem[]
  recents: string[]
  query: string
  selectedIndex: number
  onSelectedIndexChange: (next: number) => void
  onSelect: (item: MentionItem) => void
  maxHeight?: number
}

export const MentionMenu = forwardRef<HTMLDivElement, MentionMenuProps>(
  function MentionMenu(
    { files, agents, recents, query, selectedIndex, onSelectedIndexChange, onSelect, maxHeight = 280 },
    ref,
  ) {
    const fileItems: MentionItem[] = files.map((f) => ({
      key: `file:${f.id}`,
      kind: 'file',
      file: f,
      label: f.label,
      hint: f.hint,
    }))
    const agentItems: MentionItem[] = agents.map((a) => ({
      key: `agent:${a.id}`,
      kind: 'agent',
      agent: a,
      label: a.name,
      hint: a.description,
    }))

    let displayItems: MentionItem[] = []
    if (query.trim().length === 0 && recents.length > 0) {
      // No query — show recents first, then everything else.
      const recentSet = new Set(recents)
      const recentItems: MentionItem[] = []
      for (const key of recents) {
        const item = fileItems.find((i) => i.key === key) ?? agentItems.find((i) => i.key === key)
        if (item) recentItems.push(item)
      }
      const rest = [...fileItems, ...agentItems].filter((i) => !recentSet.has(i.key))
      displayItems = [...recentItems, ...rest]
    } else {
      displayItems = [...fileItems, ...agentItems]
    }

    const matches = fuzzyFilter(query, displayItems, (item) =>
      item.hint ? `${item.label} ${item.hint}` : item.label,
    )

    if (matches.length === 0) {
      return (
        <div
          ref={ref}
          className="bg-popover text-muted-foreground mb-2 rounded-lg border border-border/60 px-3 py-2.5 text-[12px] shadow-md"
        >
          <div className="flex items-center justify-between">
            <span>No results for &ldquo;{query}&rdquo;</span>
            <span className="text-muted-foreground/60 inline-flex items-center gap-1 text-[10.5px]">
              <AtSign className="size-3" /> to mention
            </span>
          </div>
        </div>
      )
    }

    const safeIndex = Math.min(selectedIndex, matches.length - 1)

    // Build sections: a Recent section when recents are pinned to the top,
    // plus Files and Agents. Preserve order within each section.
    const sections: Array<{ title: string; rows: Array<{ match: FuzzyMatch<MentionItem>; flatIndex: number }> }> = []
    const push = (title: string, row: { match: FuzzyMatch<MentionItem>; flatIndex: number }) => {
      const last = sections[sections.length - 1]
      if (last && last.title === title) last.rows.push(row)
      else sections.push({ title, rows: [row] })
    }

    matches.forEach((match, flatIndex) => {
      if (match.item.kind === 'recent') push('Recent', { match, flatIndex })
      else if (match.item.kind === 'file') push('Files', { match, flatIndex })
      else push('Agents', { match, flatIndex })
    })

    // Recents section is only shown when no query — otherwise it'd be noise.
    const showRecentsHeader =
      query.trim().length === 0 && sections.some((s) => s.title === 'Recent')

    return (
      <div
        ref={ref}
        className="bg-popover mb-2 overflow-hidden rounded-lg border border-border/60 shadow-xl shadow-black/40"
        role="listbox"
        aria-label="Mention"
      >
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
          <span className="text-muted-foreground/80 text-[10.5px] font-medium tracking-wide uppercase">
            Mention
          </span>
          <span className="text-muted-foreground/60 inline-flex items-center gap-1 text-[10.5px]">
            <AtSign className="size-3" />
            {matches.length} {matches.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        <div className="overflow-y-auto p-1" style={{ maxHeight }}>
          {sections.map((section) => (
            <div key={section.title} className="mb-1 last:mb-0">
              <div className="text-muted-foreground/70 flex items-center justify-between px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wider uppercase">
                <span>{section.title}</span>
                {showRecentsHeader && section.title === 'Recent' && (
                  <span className="text-muted-foreground/50 normal-case">pinned</span>
                )}
              </div>
              {section.rows.map(({ match, flatIndex }) => {
                const isActive = flatIndex === safeIndex
                return (
                  <button
                    key={match.item.key}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-mention={match.item.key}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => onSelectedIndexChange(flatIndex)}
                    onClick={() => onSelect(match.item)}
                    className={
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ' +
                      (isActive ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60')
                    }
                  >
                    <MentionIcon item={match.item} active={isActive} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {highlightCandidate(match.item.label, match.matchedIndices).map((part, i) =>
                          part.highlight ? (
                            <mark
                              key={i}
                              className="bg-primary/20 text-foreground rounded-sm px-0.5"
                            >
                              {part.text}
                            </mark>
                          ) : (
                            <span key={i}>{part.text}</span>
                          ),
                        )}
                      </div>
                      {match.item.hint && (
                        <div className="text-muted-foreground truncate text-[10.5px]">
                          {match.item.hint}
                        </div>
                      )}
                    </div>
                    {isActive && (
                      <CornerDownLeft className="text-muted-foreground size-3.5 shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <Footer />
      </div>
    )
  },
)

function MentionIcon({ item, active }: { item: MentionItem; active: boolean }): ReactNode {
  if (item.agent) {
    return (
      <span
        className={
          'flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border ' +
          (active ? 'border-primary/40 bg-primary/10' : 'border-border/60 bg-background/40')
        }
      >
        <AgentAvatar seed={item.agent.avatarSeed} size={20} />
      </span>
    )
  }
  if (item.file) {
    return (
      <span
        className={
          'flex size-6 shrink-0 items-center justify-center rounded-md border ' +
          (active
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-border/60 bg-background/40 text-muted-foreground')
        }
      >
        <FileCode className="size-3.5" />
      </span>
    )
  }
  return null
}

function Footer(): ReactNode {
  return (
    <div className="text-muted-foreground/70 flex items-center gap-3 border-t border-border/40 px-3 py-1.5 text-[10.5px]">
      <Hint keys={['↑', '↓']} label="navigate" />
      <Hint keys={['↵']} label="select" />
      <Hint keys={['esc']} label="close" />
    </div>
  )
}

function Hint({ keys, label }: { keys: string[]; label: string }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="border-border/60 bg-background/60 text-foreground/80 inline-flex h-4 min-w-4 items-center justify-center rounded border px-1 font-mono text-[10px]"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  )
}
