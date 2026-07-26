/**
 * Build the system prompt for a chat completion.
 *
 * The prompt always includes the BrightCode identity. When an active
 * project is set, we also inject a "working directory" hint so the agent
 * knows where it is in the user's filesystem. When tools are enabled,
 * the prompt also tells the model what tools it can call.
 *
 * Keep the wording minimal so the downstream model has room for the
 * user's actual request.
 */

import type { Project } from '@/lib/projects/store'
import { AGENT_TOOLS } from './tools'

export interface AgentSkillSummary {
  selector: string
  name: string
  description: string
  source: string
}

export interface SystemPromptContext {
  project?: Project | null
  skills?: AgentSkillSummary[]
  /** When true (default), include the "Available tools" section. */
  includeTools?: boolean
}

const BASE_PROMPT = `You are BrightCode, an AI coding assistant inside a desktop app (Electron + React). Be concise, prefer concrete code over prose, and use markdown for code blocks.`

export function buildSystemPrompt(ctx: SystemPromptContext = {}): string {
  const { project, skills = [], includeTools = true } = ctx
  const sections: string[] = [BASE_PROMPT]

  if (project) {
    const projectPath = project.path.replace(/\\/g, '/')
    sections.push(
      '',
      '## Active project',
      `- Label: ${project.label}`,
      `- Working directory: ${projectPath}`,
      '',
      'When the user asks about files, code, or the project, treat the working',
      'directory above as the project root. Do not invent paths outside it.',
      'All file paths you pass to tools must be relative to this directory.',
      'When the user asks to create, edit, or inspect a project file, perform',
      'the request with the appropriate tool instead of only describing the',
      'steps. Do not claim that file tools are unavailable unless a tool call',
      'was attempted and returned an error.',
      'After all tool work is complete, always send a concise final response',
      'confirming what was done and naming the files that were changed.',
      'When multiple tool calls are independent, emit all of them together in',
      'the same response so the app can execute them in parallel. Keep tool',
      'calls in separate rounds only when one result is required by the next.',
      'When you need to run shell commands, prefer the platform-appropriate',
      `one — Windows uses \`cd "${project.path.replace(/"/g, '\\"')}"\` style.`,
    )
  }

  if (includeTools && AGENT_TOOLS.length > 0) {
    sections.push('', '## Available tools', formatToolsForPrompt(AGENT_TOOLS))
  }

  sections.push(
    '',
    '## Skills',
    'Skills are reusable instruction packages available through list_skills, read_skill, and read_skill_file.',
    'If the user names a skill, or the task clearly matches a listed skill description, you must load its complete SKILL.md with read_skill before acting.',
    'If the task is specialized and no visible catalog entry clearly matches, search the full catalog with list_skills.',
    'Follow the loaded instructions. If SKILL.md references supporting files, use read_skill_file and read only the files required for the task.',
    'Use the smallest relevant set of skills. Do not claim to have used a skill unless read_skill succeeded.',
    'Skill instructions do not bypass tool permissions or the active-project sandbox.',
  )

  if (skills.length > 0) {
    sections.push('', '### Available skill catalog', formatSkillCatalog(skills))
  } else {
    sections.push(
      '',
      'No skill catalog was preloaded. Call list_skills when a task may benefit from a reusable skill.',
    )
  }

  return sections.join('\n')
}

function formatToolsForPrompt(tools: typeof AGENT_TOOLS): string {
  return tools
    .map((t) => {
      const props = Object.entries(t.parameters.properties)
        .map(([name, p]) => {
          const req = t.parameters.required?.includes(name) ? ' (required)' : ''
          return `  - ${name}${req}: ${p.description ?? p.type}`
        })
        .join('\n')
      return `- **${t.name}** — ${t.description}\n${props}`
    })
    .join('\n')
}

function formatSkillCatalog(skills: AgentSkillSummary[]): string {
  const MAX_CATALOG_ITEMS = 40
  const shown = skills.slice(0, MAX_CATALOG_ITEMS)
  const lines = shown.map((skill) => {
    const description = skill.description.replace(/\s+/g, ' ').trim().slice(0, 180)
    return `- **${skill.name}** [${skill.source}] — ${description}\n  selector: ${skill.selector}`
  })
  if (skills.length > shown.length) {
    lines.push(
      `- ${skills.length - shown.length} more skills are available; use list_skills to search the full catalog.`,
    )
  }
  return lines.join('\n')
}
