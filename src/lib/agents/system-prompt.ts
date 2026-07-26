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

export interface SystemPromptContext {
  project?: Project | null
  /** When true (default), include the "Available tools" section. */
  includeTools?: boolean
}

const BASE_PROMPT = `You are BrightCode, an AI coding assistant inside a desktop app (Electron + React). Be concise, prefer concrete code over prose, and use markdown for code blocks.`

export function buildSystemPrompt(ctx: SystemPromptContext = {}): string {
  const { project, includeTools = true } = ctx
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
      'When you need to run shell commands, prefer the platform-appropriate',
      `one — Windows uses \`cd "${project.path.replace(/"/g, '\\"')}"\` style.`,
    )
  }

  if (includeTools && AGENT_TOOLS.length > 0) {
    sections.push('', '## Available tools', formatToolsForPrompt(AGENT_TOOLS))
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
