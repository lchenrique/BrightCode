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
  /** Tool ids the agent should be allowed to call. */
  tools: string[]
  /**
   * Deterministic seed for the DiceBear bottts avatar. Defaults to the
   * preset id when omitted so every preset has a stable face.
   */
  avatarSeed?: string
}

/**
 * Default tool set used by the `Custom` source — same as the original
 * CreateAgentDialog. Presets override this with a tighter set tuned
 * to the persona.
 */
export const DEFAULT_TOOLS = [
  'read_file',
  'write_file',
  'search_files',
  'edit_file',
] as const

/**
 * Per-preset tool allow-list. The picker uses this to scope the agent
 * to the tools that actually match its persona — a reviewer is
 * read-only, a git workflow expert can use bash, etc.
 */
const PRESET_TOOLS: Record<string, string[]> = {
  'backend-architect': [
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'list_files',
    'bash',
  ],
  'frontend-react': [
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'list_files',
  ],
  reviewer: ['read_file', 'search_files', 'list_files'],
  'api-tester': [
    'read_file',
    'write_file',
    'edit_file',
    'search_files',
    'list_files',
    'bash',
  ],
  planner: ['read_file', 'search_files', 'list_files'],
  'git-workflow-master': [
    'read_file',
    'write_file',
    'edit_file',
    'bash',
  ],
  'reality-checker': ['read_file', 'search_files', 'list_files', 'bash'],
  'product-manager': ['read_file', 'search_files', 'list_files'],
}

const PRESET_AVATAR_SEED: Record<string, string> = {
  'backend-architect': 'preset-backend-architect',
  'frontend-react': 'preset-frontend-react',
  reviewer: 'preset-reviewer',
  'api-tester': 'preset-api-tester',
  planner: 'preset-planner',
  'git-workflow-master': 'preset-git-workflow',
  'reality-checker': 'preset-reality-checker',
  'product-manager': 'preset-product-manager',
}

const rawFiles = import.meta.glob('/agents/presets/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function extractNameFromMarkdown(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+?)\s*$/m)
  if (!match) return fallback
  // Strip a leading emoji + optional whitespace so sorting is alphabetical
  // by the actual persona name (otherwise 🧭 Product Manager sorts under 🧭).
  return match[1]!.replace(/^[\p{Extended_Pictographic}\p{Emoji_Component}]+\s*/u, '').trim()
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
      tools: PRESET_TOOLS[id] ?? [...DEFAULT_TOOLS],
      avatarSeed: PRESET_AVATAR_SEED[id] ?? `preset-${id}`,
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

export function getPresetById(id: string): AgentPreset | undefined {
  return AGENT_PRESETS.find((p) => p.id === id)
}
