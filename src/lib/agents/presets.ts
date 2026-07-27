/**
 * Bundled agent presets.
 *
 * Vite's `import.meta.glob('/agents/presets/*.md', { query: '?raw', ... })`
 * resolves to a map of { filename: string content } at build time, so
 * the markdown ships inside the renderer bundle — no IPC hop, no async
 * file read, no path resolution. Add a new `.md` to `agents/presets/`
 * and it shows up here automatically.
 *
 * The markdown is shown to the user in the CreateAgentDialog as a
 * starting point. The user can edit the description, system prompt,
 * emoji, and model before saving.
 */

export interface AgentPreset {
  /** Stable id derived from the filename (e.g. "backend", "frontend"). */
  id: string
  /** Display name. Taken from the first `# Heading` in the markdown. */
  name: string
  /** Filename (relative to `agents/presets/`) for source attribution. */
  fileName: string
  /** Full markdown content. Becomes the default system prompt. */
  content: string
}

const rawFiles = import.meta.glob('/agents/presets/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function extractNameFromMarkdown(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+?)\s*$/m)
  if (match) return match[1]!.trim()
  return fallback
}

export const AGENT_PRESETS: AgentPreset[] = Object.entries(rawFiles)
  .map(([path, content]) => {
    const fileName = path.split('/').pop() ?? path
    const id = fileName.replace(/\.md$/i, '').toLowerCase()
    return {
      id,
      name: extractNameFromMarkdown(content, id),
      fileName,
      content,
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

export function getPresetById(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id)
}
