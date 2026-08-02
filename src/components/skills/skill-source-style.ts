import { Bot, Boxes, Cpu, Folder, Sparkles, Terminal } from 'lucide-react'

export type SkillSourceStyle = {
  badge: string
  text: string
  icon: typeof Sparkles
}

const SOURCE_COLORS: Record<string, SkillSourceStyle> = {
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
  user: {
    badge: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
    text: 'text-rose-400',
    icon: Sparkles,
  },
}

const FALLBACK_STYLE = SOURCE_COLORS.agents

export function getSkillSourceStyle(source: string): SkillSourceStyle {
  return SOURCE_COLORS[source] ?? FALLBACK_STYLE
}
