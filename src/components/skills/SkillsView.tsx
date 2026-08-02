import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles,
  Search,
  FileText,
  RefreshCw,
  ChevronRight,
  X,
  Check,
  LoaderCircle,
  Save,
} from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  DocumentDualEditor,
  DocumentModeSwitcher,
  type DocumentViewMode,
} from '@/components/files/DocumentDualEditor'
import { useActiveProject } from '@/hooks/use-projects'
import { getSkillSourceStyle } from './skill-source-style'
import { cn } from '@/lib/utils'

export interface DiscoveredSkill {
  id: string
  name: string
  description: string
  source: string
  sourceLabel: string
  folderPath: string
  skillFilePath: string
  author?: string
  version?: string
  tags?: string[]
}

type SourceFilter = 'all' | 'codex' | 'agents' | 'gemini' | 'opencode' | 'project' | 'user'

const SKILLS_DRAWER_WIDTH_KEY = 'brightcode:skills-drawer-width'
const SKILLS_DRAWER_DEFAULT_WIDTH = 560
const SKILLS_DRAWER_MIN_WIDTH = 420
const SKILLS_DRAWER_MAX_WIDTH = 960

export function SkillsView() {
  const activeProject = useActiveProject()
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [selectedSkill, setSelectedSkill] = useState<DiscoveredSkill | null>(null)
  const [skillContent, setSkillContent] = useState<string | null>(null)
  const [savedSkillContent, setSavedSkillContent] = useState<string | null>(null)
  const [loadingContent, setLoadingContent] = useState(false)
  const [savingSkill, setSavingSkill] = useState(false)
  const [skillSaveNotice, setSkillSaveNotice] = useState<string | null>(null)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [skillMode, setSkillMode] = useState<DocumentViewMode>('preview')
  const [drawerWidth, setDrawerWidth] = useState(() => {
    const stored = Number.parseFloat(
      localStorage.getItem(SKILLS_DRAWER_WIDTH_KEY) ?? '',
    )
    return clampSkillsDrawerWidth(
      Number.isFinite(stored) ? stored : SKILLS_DRAWER_DEFAULT_WIDTH,
    )
  })

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
    if (
      selectedSkill?.id !== skill.id &&
      skillContent !== null &&
      savedSkillContent !== null &&
      skillContent !== savedSkillContent &&
      !window.confirm('Discard the unsaved changes to this skill?')
    ) {
      return
    }
    setSelectedSkill(skill)
    setLoadingContent(true)
    setSkillContent(null)
    setSavedSkillContent(null)
    setSkillSaveNotice(null)
    setSkillError(null)
    setSkillMode('preview')
    try {
      if (window.electronAPI?.skills) {
        const raw = await window.electronAPI.skills.read(skill.skillFilePath)
        setSkillContent(raw)
        setSavedSkillContent(raw)
      } else {
        const fallback = `# ${skill.name}\n\n${skill.description}\n\n*Path:* \`${skill.skillFilePath}\``
        setSkillContent(fallback)
        setSavedSkillContent(fallback)
      }
    } catch (err) {
      setSkillError(`Error loading skill content: ${String(err)}`)
    } finally {
      setLoadingContent(false)
    }
  }

  const closeSelectedSkill = () => {
    if (
      skillContent !== null &&
      savedSkillContent !== null &&
      skillContent !== savedSkillContent &&
      !window.confirm('Close this skill without saving your changes?')
    ) {
      return
    }
    setSelectedSkill(null)
    setSkillContent(null)
    setSavedSkillContent(null)
    setSkillError(null)
  }

  const saveSelectedSkill = async () => {
    if (
      !selectedSkill ||
      skillContent === null ||
      savedSkillContent === null ||
      skillContent === savedSkillContent ||
      savingSkill
    ) {
      return
    }

    setSavingSkill(true)
    setSkillError(null)
    try {
      if (window.electronAPI?.skills) {
        const saved = await window.electronAPI.skills.write(
          selectedSkill.skillFilePath,
          skillContent,
        )
        if (!saved) throw new Error('The skill could not be saved.')
      }
      setSavedSkillContent(skillContent)
      setSkillSaveNotice('SKILL.md saved')
    } catch (err) {
      setSkillError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingSkill(false)
    }
  }

  useEffect(() => {
    if (!skillSaveNotice) return
    const timer = window.setTimeout(() => setSkillSaveNotice(null), 2200)
    return () => window.clearTimeout(timer)
  }, [skillSaveNotice])

  useEffect(() => {
    localStorage.setItem(SKILLS_DRAWER_WIDTH_KEY, String(drawerWidth))
  }, [drawerWidth])

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
      user: 0,
    }
    for (const s of skills) {
      if (s.source in counts && s.source !== 'all') {
        const source = s.source as Exclude<SourceFilter, 'all'>
        counts[source] += 1
      }
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
                  { id: 'user', label: 'User Library' },
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
                  const style = getSkillSourceStyle(s.source)
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
          <aside
            className="border-border/60 bg-card/60 relative flex max-w-full shrink-0 flex-col border-l backdrop-blur"
            style={{ width: `${drawerWidth}px` }}
            aria-label="Skill editor"
          >
            <SkillsDrawerResizeHandle
              width={drawerWidth}
              onResize={setDrawerWidth}
            />

            <div className="border-border/60 flex h-12 shrink-0 items-center gap-2 border-b px-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <FileText className="text-primary size-4 shrink-0" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="text-foreground truncate text-[12.5px] font-semibold">
                      {selectedSkill.name}
                    </span>
                    <span
                      className={cn(
                        'hidden shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium xl:inline-flex',
                        getSkillSourceStyle(selectedSkill.source).badge,
                      )}
                    >
                      {selectedSkill.sourceLabel}
                    </span>
                  </div>
                  <p
                    className="text-muted-foreground truncate font-mono text-[9.5px]"
                    title={selectedSkill.skillFilePath}
                  >
                    {selectedSkill.skillFilePath}
                  </p>
                </div>
              </div>

              <DocumentModeSwitcher
                mode={skillMode}
                onModeChange={setSkillMode}
                compact
              />

              <Button
                variant="outline"
                size="sm"
                onClick={() => void saveSelectedSkill()}
                disabled={
                  savingSkill ||
                  skillContent === null ||
                  savedSkillContent === null ||
                  skillContent === savedSkillContent
                }
                className="h-7 shrink-0 gap-1 px-2 text-[10.5px]"
                title="Save SKILL.md (Ctrl+S)"
              >
                {savingSkill ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : skillSaveNotice ? (
                  <Check className="size-3 text-emerald-500" />
                ) : (
                  <Save className="size-3" />
                )}
                <span className="hidden 2xl:inline">
                  {skillContent !== null &&
                  savedSkillContent !== null &&
                  skillContent !== savedSkillContent
                    ? 'Save'
                    : 'Saved'}
                </span>
              </Button>

              <Button
                variant="ghost"
                size="icon-sm"
                onClick={closeSelectedSkill}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1">
              {loadingContent ? (
                <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <RefreshCw className="size-5 animate-spin text-primary" />
                  <span className="text-[12px]">Loading SKILL.md...</span>
                </div>
              ) : skillError && skillContent === null ? (
                <div className="text-destructive p-4 text-[12px]">
                  {skillError}
                </div>
              ) : skillContent !== null && savedSkillContent !== null ? (
                <div className="flex h-full min-h-0 flex-col">
                  {skillError && (
                    <div className="border-destructive/30 bg-destructive/10 text-destructive shrink-0 border-b px-3 py-2 text-[11px]">
                      {skillError}
                    </div>
                  )}
                  <div className="min-h-0 flex-1">
                    <DocumentDualEditor
                      key={selectedSkill.id}
                      filePath={selectedSkill.skillFilePath}
                      language="markdown"
                      content={skillContent}
                      savedContent={savedSkillContent}
                      onChange={setSkillContent}
                      onSave={() => void saveSelectedSkill()}
                      saving={savingSkill}
                      saveNotice={skillSaveNotice}
                      mode={skillMode}
                      onModeChange={setSkillMode}
                      showToolbar={false}
                      initialMode="preview"
                    />
                  </div>
                </div>
              ) : (
                <div className="text-muted-foreground p-4 text-[12px]">
                  No content.
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

function clampSkillsDrawerWidth(width: number): number {
  const viewportMaximum =
    typeof window === 'undefined'
      ? SKILLS_DRAWER_MAX_WIDTH
      : Math.max(SKILLS_DRAWER_MIN_WIDTH, window.innerWidth - 360)
  return Math.min(
    Math.max(width, SKILLS_DRAWER_MIN_WIDTH),
    Math.min(SKILLS_DRAWER_MAX_WIDTH, viewportMaximum),
  )
}

function SkillsDrawerResizeHandle({
  width,
  onResize,
}: {
  width: number
  onResize: (width: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startWidth: number
  } | null>(null)

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    document.documentElement.classList.remove('sidebar-resizing')
  }

  useEffect(
    () => () => document.documentElement.classList.remove('sidebar-resizing'),
    [],
  )

  return (
    <div
      role="separator"
      aria-label="Resize skill editor"
      aria-orientation="vertical"
      aria-valuemin={SKILLS_DRAWER_MIN_WIDTH}
      aria-valuemax={SKILLS_DRAWER_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="group/skill-resize absolute inset-y-0 -left-2 z-20 hidden w-4 cursor-col-resize touch-none md:block"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        document.documentElement.classList.add('sidebar-resizing')
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        onResize(
          clampSkillsDrawerWidth(
            drag.startWidth - (event.clientX - drag.startX),
          ),
        )
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(SKILLS_DRAWER_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowLeft' ? 16 : -16
        onResize(clampSkillsDrawerWidth(width + delta))
      }}
    >
      <div
        className={cn(
          'mx-auto h-full w-0.5 transition-colors',
          dragging
            ? 'bg-primary/60'
            : 'group-hover/skill-resize:bg-primary/50',
        )}
      />
    </div>
  )
}
