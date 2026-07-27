/**
 * Tool definitions for the agent — the single source of truth for what
 * the model can ask BrightCode to do. The format handlers convert these
 * to the provider-native shape (OpenAI `tools`, Anthropic `tools`,
 * Gemini `functionDeclarations`).
 *
 * All tools are sandboxed to the active project root. Paths must be
 * relative; absolute paths are rejected.
 */

import type { ToolDefinition } from '@/lib/providers/types'
import { agentStore } from './store'

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read the contents of a file in the project. Paths are relative to the project root (e.g. "src/index.ts"). Returns the file content as a UTF-8 string.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root (e.g. "src/index.ts").',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file. Creates parent directories as needed. Use this for new files or full rewrites — prefer edit_file for targeted changes.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root.',
        },
        content: {
          type: 'string',
          description: 'Full file content to write.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace a string in a file. Safer than write_file for small changes — you only specify what to find and what to replace it with. The old text must match exactly once (or set replace_all=true if you expect multiple matches).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the project root.',
        },
        oldText: {
          type: 'string',
          description: 'Exact substring to find in the file.',
        },
        newText: {
          type: 'string',
          description: 'Replacement string.',
        },
        replaceAll: {
          type: 'boolean',
          description: 'Replace all occurrences (default: false, requires exactly one match).',
        },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'list_files',
    description:
      'List files and directories in the project. By default returns the immediate children of the project root (skipping node_modules, .git, and dotfiles).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory to list, relative to project root. Defaults to "." (the root).',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, recurse into subdirectories.',
        },
      },
    },
  },
  {
    name: 'search_files',
    description:
      'Search for a string across files in the project. Returns up to 200 matches with file path, line number, and a snippet of context. Skips node_modules, .git, dotfiles, and binary files (images, archives, etc).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The literal string to search for.',
        },
        path: {
          type: 'string',
          description: 'Directory to search in, relative to project root. Defaults to ".".',
        },
        includePattern: {
          type: 'string',
          description: 'Optional filename glob to limit the search, e.g. "*.ts" or "*.md".',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_skills',
    description:
      'Discover reusable agent skills installed on the computer or in the active project. Search by name, description, tag, or source. Returns safe selectors; use read_skill to load a selected skill before applying it.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional search text. Omit it to list every available skill.',
        },
      },
    },
  },
  {
    name: 'read_skill',
    description:
      'Load the complete SKILL.md instructions for one available skill. Call this before applying a skill that the user named or whose description clearly matches the task.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description:
            'The exact skill selector returned by list_skills or the exact skill name when unambiguous.',
        },
      },
      required: ['skill'],
    },
  },
  {
    name: 'read_skill_file',
    description:
      'Read a text instruction, reference, template, or other supporting file referenced by a loaded skill. The path must be relative to that skill folder.',
    parameters: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description:
            'The exact skill selector returned by list_skills or read_skill.',
        },
        path: {
          type: 'string',
          description:
            'Supporting file path relative to the skill folder, such as "references/api.md".',
        },
      },
      required: ['skill', 'path'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command inside the project working directory. The user is shown the exact command and must approve it before it runs, so prefer this only for commands the user has effectively consented to (installing dependencies, running tests, git operations, build/lint, inspecting the project). Do NOT use this to read or write files you can reach with read_file / write_file / edit_file. Output is truncated at ~50KB; long-running commands must finish within the timeout (default 60s, max 5min).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The shell command to run. Use platform-appropriate syntax. The command is run with `shell: true` so pipes, redirects, and chained commands work.',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory, relative to project root. Defaults to the project root. Stays inside the project sandbox.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'Hard timeout in milliseconds. Defaults to 60000 (1 min). The process is SIGKILLed at the deadline.',
        },
      },
      required: ['command'],
    },
  },
]

export function buildAgentTools(): ToolDefinition[] {
  return agentStore.list()
    .filter((a) => a.enabled)
    .map((agent) => ({
      name: `delegate_to_${agent.name.toLowerCase().replace(/\s+/g, '_')}`,
      description: `Delegate a task to the ${agent.name} agent. ${agent.description}`,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task to delegate' },
          context: { type: 'string', description: 'Additional context' },
        },
        required: ['task'],
      },
    }))
}

export function getAllTools(): ToolDefinition[] {
  return [...AGENT_TOOLS, ...buildAgentTools()]
}
