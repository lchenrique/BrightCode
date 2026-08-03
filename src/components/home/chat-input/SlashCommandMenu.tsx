/**
 * SlashCommandMenu — the `/`-triggered command picker.
 *
 * Pattern (OpenCode / Orkas / OpenChamber style):
 *   - Header label + keyboard hint on the right
 *   - Filtered, score-sorted list with the selected row highlighted
 *   - Footer with navigation hints
 *   - Mouse hover sets the active row so keyboard and mouse feel unified
 *   - Fuzzy-matched chars in the label are wrapped in <mark> so the
 *     user can see why a row matched
 *
 * The parent owns the selected index and the keyboard handler. The
 * textarea is what intercepts ArrowUp/Down/Enter/Escape — this component
 * just renders and emits `onSelect` when a row is chosen.
 */

import { forwardRef, type ReactNode } from 'react'
import { CornerDownLeft, Slash } from 'lucide-react'
import { fuzzyFilter, highlightCandidate, type FuzzyMatch } from './fuzzy'

export interface SlashCommandItem {
  id: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  insertText: string
  /** Optional category used to group commands in the menu. */
  category?: string
}

export interface SlashCommandMenuProps {
  items: SlashCommandItem[]
  query: string
  selectedIndex: number
  onSelectedIndexChange: (next: number) => void
  onSelect: (item: SlashCommandItem) => void
  /** Max height in pixels. Defaults to 256. */
  maxHeight?: number
}

export const SlashCommandMenu = forwardRef<HTMLDivElement, SlashCommandMenuProps>(
  function SlashCommandMenu(
    { items, query, selectedIndex, onSelectedIndexChange, onSelect, maxHeight = 256 },
    ref,
  ) {
    const matches = fuzzyFilter(query, items, (item) => `${item.label} ${item.id}`)

    if (matches.length === 0) {
      return (
        <div
          ref={ref}
          className="bg-popover text-muted-foreground mb-2 rounded-lg border border-border/60 px-3 py-2.5 text-[12px] shadow-md"
        >
          <EmptyState query={query} />
        </div>
      )
    }

    // Clamp the selected index so it stays valid as the query narrows.
    const safeIndex = Math.min(selectedIndex, matches.length - 1)

    // Group by category so commands are visually organized.
    const groups: Array<{ category: string; rows: Array<{ match: FuzzyMatch<SlashCommandItem>; flatIndex: number }> }> = []
    matches.forEach((match, flatIndex) => {
      const cat = match.item.category ?? 'Commands'
      const last = groups[groups.length - 1]
      if (last && last.category === cat) {
        last.rows.push({ match, flatIndex })
      } else {
        groups.push({ category: cat, rows: [{ match, flatIndex }] })
      }
    })

    return (
      <div
        ref={ref}
        className="bg-popover mb-2 overflow-hidden rounded-lg border border-border/60 shadow-xl shadow-black/40"
        role="listbox"
        aria-label="Slash commands"
      >
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
          <span className="text-muted-foreground/80 text-[10.5px] font-medium tracking-wide uppercase">
            Commands
          </span>
          <span className="text-muted-foreground/60 inline-flex items-center gap-1 text-[10.5px]">
            <Slash className="size-3" />
            {matches.length} {matches.length === 1 ? 'match' : 'matches'}
          </span>
        </div>
        <div className="overflow-y-auto p-1" style={{ maxHeight }}>
          {groups.map((group) => (
            <div key={group.category} className="mb-1 last:mb-0">
              {groups.length > 1 && (
                <div className="text-muted-foreground/70 px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wider uppercase">
                  {group.category}
                </div>
              )}
              {group.rows.map(({ match, flatIndex }) => {
                const isActive = flatIndex === safeIndex
                return (
                  <button
                    key={match.item.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-slash-cmd={match.item.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => onSelectedIndexChange(flatIndex)}
                    onClick={() => onSelect(match.item)}
                    className={
                      'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors ' +
                      (isActive ? 'bg-accent text-foreground' : 'text-foreground/85 hover:bg-accent/60')
                    }
                  >
                    <span
                      className={
                        'flex size-6 shrink-0 items-center justify-center rounded-md border ' +
                        (isActive
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border/60 bg-background/40 text-muted-foreground')
                      }
                    >
                      <match.item.icon className="size-3.5" />
                    </span>
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
                      <div className="text-muted-foreground truncate text-[10.5px]">
                        {match.item.description}
                      </div>
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

function EmptyState({ query }: { query: string }): ReactNode {
  return (
    <div className="flex items-center justify-between">
      <span>No commands match &ldquo;{query}&rdquo;</span>
    </div>
  )
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
