import { useEffect, useState, useMemo } from 'react'
import {
  Sparkles,
  Search,
  Folder,
  FileText,
  RefreshCw,
  ChevronRight,
  X,
  Bot,
  Terminal,
  Cpu,
  Boxes,
} from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { useActiveProject } from '@/hooks/use-projects'
import { cn } from '@/lib/utils'

export interface DiscoveredSkill {
  id: string
  name: string
  description: string
  source: 'codex' | 'agents' | 'gemini' | 'opencode' | 'project'
  sourceLabel: string
  folderPath: string
  skillFilePath: string
  author?: string
  version?: string
  tags?: string[]
}

type SourceFilter = 'all' | 'codex' | 'agents' | 'gemini' | 'opencode' | 'project'

const SOURCE_COLORS: Record<
  DiscoveredSkill['source'],
  { badge: string; text: string; icon: typeof Sparkles }
> = {
  codex: {
    badge: 'bg-amber-500/10 text-amber-500 border-amber-500/30',
    text: 'text-amber-500',
    icon: Terminal,
  },
  agents: {
    badge: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
    text: 'text-purple-400',
    icon: Bot,
  },
  gemini: {
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    text: 'text-emerald-400',
    icon: Cpu,
  },
  opencode: {
    badge: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
    text: 'text-cyan-400',
    icon: Boxes,
  },
  project: {
    badge: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
    text: 'text-indigo-400',
    icon: Folder,
  },
}

export function SkillsView() {
  const activeProject = useActiveProject()
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [selectedSkill, setSelectedSkill] = useState<DiscoveredSkill | null>(null)
  const [skillContent, setSkillContent] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)

  const loadSkills = async () => {
    setLoading(true)
    try {
      if (window.electronAPI?.skills) {
        const list = await window.electronAPI.skills.list(activeProject?.path)
        setSkills(list)
      } else {
        // Mock fallback for browser dev mode
        setSkills([
          {
            id: 'mock_1',
            name: 'skill-creator',
            description: 'Guide for creating new skills for AI agents',
            source: 'codex',
            sourceLabel: 'Codex System',
            folderPath: 'C:\\Users\\user\\.codex\\skills\\.system\\skill-creator',
            skillFilePath: 'C:\\Users\\user\\.codex\\skills\\.system\\skill-creator\\SKILL.md',
            author: 'OpenAI / Codex',
          },
          {
            id: 'mock_2',
            name: 'orchestration',
            description: 'Subagent workflow orchestration and delegation',
            source: 'agents',
            sourceLabel: 'Agent Team',
            folderPath: 'C:\\Users\\user\\.agents\\skills\\orchestration',
            skillFilePath: 'C:\\Users\\user\\.agents\\skills\\orchestration\\SKILL.md',
          },
        ])
      }
    } catch (err) {
      console.error('[skills] failed to load skills:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadSkills()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.path])

  const handleSelectSkill = async (skill: DiscoveredSkill) => {
    setSelectedSkill(skill)
    setLoadingContent(true)
    setSkillContent(null)
    try {
      if (window.electronAPI?.skills) {
        const raw = await window.electronAPI.skills.read(skill.skillFilePath)
        setSkillContent(raw)
      } else {
        setSkillContent(`# ${skill.name}\n\n${skill.description}\n\n*Path:* \`${skill.skillFilePath}\``)
      }
    } catch (err) {
      setSkillContent(`*Error loading skill content:* ${String(err)}`)
    } finally {
      setLoadingContent(false)
    }
  }

  const filteredSkills = useMemo(() => {
    return skills.filter((s) => {
      const matchSource = sourceFilter === 'all' || s.source === sourceFilter
      const query = search.trim().toLowerCase()
      const matchQuery =
        !query ||
        s.name.toLowerCase().includes(query) ||
        s.description.toLowerCase().includes(query) ||
        s.folderPath.toLowerCase().includes(query) ||
        (s.tags && s.tags.some((t) => t.toLowerCase().includes(query)))
      return matchSource && matchQuery
    })
  }, [skills, sourceFilter, search])

  const sourceCounts = useMemo(() => {
    const counts: Record<SourceFilter, number> = {
      all: skills.length,
      codex: 0,
      agents: 0,
      gemini: 0,
      opencode: 0,
      project: 0,
    }
    for (const s of skills) {
      counts[s.source] = (counts[s.source] || 0) + 1
    }
    return counts
  }, [skills])

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="border-border/60 flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="size-4" />
            </div>
            <div>
              <h1 className="text-foreground text-[14px] font-semibold tracking-tight">
                Skills Library
              </h1>
              <p className="text-muted-foreground text-[11px]">
                {skills.length} skills discovered across configuration folders
              </p>
            </div>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => void loadSkills()}
          disabled={loading}
          className="gap-1.5 text-[12px]"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left/Middle: Search + Filters + Grid */}
        <div className="flex flex-1 flex-col overflow-y-auto px-6 py-5">
          {/* Controls: Search & Category Pills */}
          <div className="flex flex-col gap-4">
            <div className="relative w-full max-w-md">
              <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search skills by name, description, path or tags..."
                className="pl-9 text-[13px]"
              />
            </div>

            {/* Filter Pills */}
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { id: 'all', label: 'All Sources' },
                  { id: 'codex', label: 'Codex System' },
                  { id: 'agents', label: 'Agent Team' },
                  { id: 'gemini', label: 'Antigravity / Gemini' },
                  { id: 'opencode', label: 'OpenCode Collection' },
                  { id: 'project', label: 'Project Local' },
                ] as const
              ).map(({ id, label }) => {
                const count = sourceCounts[id]
                const active = sourceFilter === id
                if (id !== 'all' && count === 0) return null
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSourceFilter(id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground',
                    )}
                  >
                    <span>{label}</span>
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.2 text-[10.5px] font-semibold',
                        active ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Grid of Skill Cards */}
          <div className="mt-6">
            {loading ? (
              <div className="flex h-64 w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                <RefreshCw className="size-6 animate-spin text-primary" />
                <span className="text-[13px]">Scanning skill directories...</span>
              </div>
            ) : filteredSkills.length === 0 ? (
              <div className="border-border/60 bg-card/20 flex h-64 w-full flex-col items-center justify-center rounded-xl border border-dashed text-center">
                <Sparkles className="text-muted-foreground/50 mb-2 size-8" />
                <p className="text-foreground text-[14px] font-medium">No skills found</p>
                <p className="text-muted-foreground text-[12px]">
                  No skills matched your search criteria or filter.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                {filteredSkills.map((s) => {
                  const style = SOURCE_COLORS[s.source]
                  const Icon = style.icon
                  const isSelected = selectedSkill?.id === s.id

                  return (
                    <div
                      key={s.id}
                      onClick={() => void handleSelectSkill(s)}
                      className={cn(
                        'group border-border/60 bg-card/40 hover:border-primary/50 relative flex flex-col justify-between rounded-xl border p-4 transition-all duration-200 hover:shadow-md cursor-pointer',
                        isSelected && 'border-primary ring-1 ring-primary/40 bg-card/80',
                      )}
                    >
                      <div>
                        {/* Top Badge */}
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-wide uppercase',
                              style.badge,
                            )}
                          >
                            <Icon className="size-3" />
                            {s.sourceLabel}
                          </span>

                          {s.version && (
                            <span className="text-muted-foreground text-[10.5px]">
                              v{s.version}
                            </span>
                          )}
                        </div>

                        {/* Title & Description */}
                        <h3 className="text-foreground group-hover:text-primary mt-2.5 text-[14px] font-semibold transition-colors">
                          {s.name}
                        </h3>

                        <p className="text-muted-foreground/90 mt-1 line-clamp-2 text-[12.5px] leading-relaxed">
                          {s.description}
                        </p>
                      </div>

                      {/* Footer: path & action */}
                      <div className="mt-4 pt-2 border-t border-border/30 flex items-center justify-between gap-2">
                        <span
                          title={s.skillFilePath}
                          className="text-muted-foreground/70 truncate text-[11px] font-mono"
                        >
                          {s.folderPath.split('\\').pop() || s.folderPath.split('/').pop()}
                        </span>

                        <span className="text-primary opacity-0 group-hover:opacity-100 flex items-center text-[12px] font-medium transition-opacity">
                          View <ChevronRight className="size-3.5" />
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Skill Detail Drawer / Viewer */}
        {selectedSkill && (
          <aside className="border-border/60 bg-card/60 flex w-96 shrink-0 flex-col border-l backdrop-blur">
            <div className="border-border/60 flex items-center justify-between border-b p-3.5">
              <div className="flex min-w-0 items-center gap-2">
                <FileText className="text-primary size-4 shrink-0" />
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {selectedSkill.name}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSelectedSkill(null)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="mb-4 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                      SOURCE_COLORS[selectedSkill.source].badge,
                    )}
                  >
                    {selectedSkill.sourceLabel}
                  </span>
                  {selectedSkill.author && (
                    <span className="text-muted-foreground text-[11px]">
                      by {selectedSkill.author}
                    </span>
                  )}
                </div>

                <div className="border-border/40 bg-secondary/30 rounded-md border p-2 text-[11px] font-mono text-muted-foreground break-all">
                  {selectedSkill.skillFilePath}
                </div>
              </div>

              {loadingContent ? (
                <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <RefreshCw className="size-5 animate-spin text-primary" />
                  <span className="text-[12px]">Loading SKILL.md...</span>
                </div>
              ) : (
                <div className="prose prose-invert max-w-none text-[13px]">
                  <MarkdownRenderer content={skillContent || '*No content*'} />
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
