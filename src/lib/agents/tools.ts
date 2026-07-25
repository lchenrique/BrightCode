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
]
