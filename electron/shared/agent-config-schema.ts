/**
 * Agent runtime configuration schema — versioned, validated at startup and
 * on every IPC command.
 *
 * References:
 *   - OpenCode permissions: https://opencode.ai/docs/permissions/
 *   - Pattern matching for bash: `"git status *": "allow"`
 *   - Permission keys: read, edit, glob, grep, bash, task, skill, lsp,
 *     question, webfetch, websearch, external_directory, doom_loop
 *   - Decision values: "allow" | "ask" | "deny"
 *   - Doom loop: same tool+input repeats 3x → ask
 *   - External dir: tool touches path outside project root → ask
 *   - .env files: denied by default on read
 *
 * Layer precedence (last wins, unless a hard guard blocks it):
 *   1. Hard safety guards (non-overridable)
 *   2. Built-in BrightCode defaults
 *   3. User settings (electron-store under user-data)
 *   4. Project .brightcode/agent.json (trusted)
 *   5. Agent definition (AgentDefinition.permissionProfile)
 *   6. Thread settings
 *   7. Per-turn explicit overrides
 */

import Ajv from 'ajv'

// ── Versioned schema ID ─────────────────────────────────────────────────────

export const CONFIG_SCHEMA_ID = 'brightcode:agent-config:v1'

// ── Primitive types ─────────────────────────────────────────────────────────

export type PermissionAction = 'allow' | 'ask' | 'deny'

/** Glob/regex pattern keyed to a permission decision. */
export type PermissionRule = Partial<Record<string, PermissionAction>>

/**
 * Permission categories mirroring OpenCode's surface.
 * Each key maps to a set of pattern→decision rules.
 */
export interface PermissionRules {
  read?: PermissionRule        // file reads; *.env denied by default
  edit?: PermissionRule         // write, edit, patch
  glob?: PermissionRule         // glob patterns
  grep?: PermissionRule         // regex content search
  bash?: PermissionRule         // shell commands; pattern = parsed command
  task?: PermissionRule          // subagent launch
  skill?: PermissionRule         // skill loading
  lsp?: PermissionRule           // LSP queries
  question?: PermissionRule       // user questions during execution
  webfetch?: PermissionRule        // URL fetches
  websearch?: PermissionRule      // web search queries
  external_directory?: PermissionRule // paths outside project root
  doom_loop?: PermissionRule       // same tool+input 3x
}

// ── Permission profiles ──────────────────────────────────────────────────────

/**
 * Built-in BrightCode permission profiles.
 *   - read_only:     no writes, no bash, no network
 *   - workspace_write: sandboxed filesystem + bash with approval, no external dirs
 *   - full_access:   everything allowed (trusted local projects only)
 */
export type PermissionProfileName = 'read_only' | 'workspace_write' | 'full_access'

export const BUILTIN_PROFILES: Record<PermissionProfileName, PermissionRules> = {
  read_only: {
    read: { '*': 'allow' },
    edit: { '*': 'deny' },
    glob: { '*': 'deny' },
    grep: { '*': 'deny' },
    bash: { '*': 'deny' },
    task: { '*': 'deny' },
    skill: { '*': 'allow' },
    lsp: { '*': 'allow' },
    question: { '*': 'allow' },
    webfetch: { '*': 'deny' },
    websearch: { '*': 'deny' },
    external_directory: { '*': 'deny' },
    doom_loop: { '*': 'ask' },
  },
  workspace_write: {
    read: { '*': 'allow' },
    edit: { '*': 'ask' },
    glob: { '*': 'allow' },
    grep: { '*': 'allow' },
    bash: { '*': 'ask' },
    task: { '*': 'ask' },
    skill: { '*': 'allow' },
    lsp: { '*': 'allow' },
    question: { '*': 'allow' },
    webfetch: { '*': 'ask' },
    websearch: { '*': 'ask' },
    external_directory: { '*': 'ask' },
    doom_loop: { '*': 'ask' },
  },
  full_access: {
    read: { '*': 'allow' },
    edit: { '*': 'allow' },
    glob: { '*': 'allow' },
    grep: { '*': 'allow' },
    bash: { '*': 'allow' },
    task: { '*': 'allow' },
    skill: { '*': 'allow' },
    lsp: { '*': 'allow' },
    question: { '*': 'allow' },
    webfetch: { '*': 'allow' },
    websearch: { '*': 'allow' },
    external_directory: { '*': 'allow' },
    doom_loop: { '*': 'allow' },
  },
}

// ── MCP server configuration ─────────────────────────────────────────────────

export interface McpServerConfig {
  /** "user:<name>" or "project:<name>" — determines namespace and trust level. */
  id: string
  /** stdio or http */
  transport: 'stdio' | 'http'
  /** Path to the server binary/script (stdio) or URL (http) */
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Per-tool deny list. Tool names are whatever the server exposes. */
  disabledTools?: string[]
}

export interface McpServers {
  [namespaceId: string]: McpServerConfig
}

// ── Root config schema ───────────────────────────────────────────────────────

export interface AgentConfig {
  /** Schema version. Must match CONFIG_SCHEMA_ID. */
  $schema?: string

  /** Human-readable label shown in the UI. */
  label?: string

  /**
   * Active permission profile. Defaults to 'workspace_write'.
   * Agent definitions and thread settings can narrow this but never broaden it.
   */
  permissionProfile?: PermissionProfileName

  /**
   * Per-tool permission overrides. Merged after the profile.
   * Last matching rule wins; later layers cannot bypass hard guards.
   */
  permissions?: PermissionRules

  /**
   * MCP servers available for this context.
   * Namespaced by source so project config cannot silently replace a user server.
   * Format: "user:<name>" or "project:<name>"
   */
  mcpServers?: McpServers

  /**
   * Optional additional system prompt text appended after BrightCode defaults.
   */
  additionalInstructions?: string

  /**
   * Allowed model IDs for this context. Empty/undefined = all configured models.
   */
  allowedModels?: string[]

  /**
   * Denied model IDs. Takes precedence over allowedModels.
   */
  deniedModels?: string[]

  /**
   * Subagent depth limit. Default 1, hard max 2 unless an explicit trusted rule permits more.
   */
  maxSubagentDepth?: number

  /**
   * Token budget ceiling for subagents combined (approximate). 0 = unlimited.
   */
  maxSubagentTokens?: number
}

/** The JSON Schema document. Defined once as a plain object. */
const CONFIG_SCHEMA_DOC = {
  $id: CONFIG_SCHEMA_ID,
  type: 'object',
  properties: {
    label: { type: 'string', maxLength: 200 },
    permissionProfile: {
      type: 'string',
      enum: ['read_only', 'workspace_write', 'full_access'],
    },
    permissions: { type: 'object', additionalProperties: { type: 'object' } },
    mcpServers: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          transport: { type: 'string', enum: ['stdio', 'http'] },
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          disabledTools: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'transport', 'command'],
        additionalProperties: false,
      },
    },
    additionalInstructions: { type: 'string', maxLength: 50_000 },
    allowedModels: { type: 'array', items: { type: 'string' } },
    deniedModels: { type: 'array', items: { type: 'string' } },
    maxSubagentDepth: { type: 'integer', minimum: 0, maximum: 5 },
    maxSubagentTokens: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
} as const

// ── Ajv validator ───────────────────────────────────────────────────────────

type AjvValidateFn = (data: unknown) => boolean

/** Compiled once; reused for every validation call. */
let _validator: AjvValidateFn | null = null

function getValidator(): AjvValidateFn {
  if (_validator) return _validator
  const ajv = new Ajv({ allErrors: true, strict: true })
  _validator = ajv.compile(CONFIG_SCHEMA_DOC)
  return _validator
}

/**
 * Validate a plain config object against the schema.
 * Returns an array of human-readable errors, or [] if valid.
 */
export function validateConfig(config: unknown): string[] {
  const validator = getValidator()
  const valid = validator(config)
  if (valid) return []
  const errors = (validator as { errors?: unknown[] }).errors
  if (!errors) return []
  return (errors as { message?: string; keyword: string; instanceLoc?: string; params: Record<string, unknown> }[]).map((e) => {
    // Try to include the field name — Ajv v8 puts it in params for
    // numeric constraints, but instanceLoc is "undefined" for those cases.
    const params = e.params
    const fieldName =
      'missingProperty' in params
        ? String(params.missingProperty)
        : 'allowedValues' in params
          ? String(params.allowedValues)
          : 'patternName' in params
            ? String(params.patternName)
            : e.instanceLoc !== 'undefined' && e.instanceLoc !== ''
              ? e.instanceLoc
              : '(unknown field)'
    const msg = e.message ?? 'validation error'
    return `${fieldName} ${e.keyword} — ${msg}`
  })
}

// ── Merge helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a permission decision for a given tool+resource.
 *
 * Rules are merged in layer order (last wins). Hard guards (credential files)
 * are applied BEFORE rule resolution and cannot be overridden.
 *
 * @param tool        The tool category (read, bash, edit, etc.)
 * @param resource    The resource being accessed (file path, command string, URL, etc.)
 * @param layers      Rule objects in precedence order (index 0 = lowest priority)
 */
export function resolvePermission(
  tool: keyof PermissionRules,
  resource: string,
  layers: PermissionRules[],
): PermissionAction {
  // Hard guard: credential and secret files are always denied, regardless of profile.
  if (tool === 'read') {
    const LOWER = resource.toLowerCase()
    // .env files — deny .env, .env.local, .env.production, etc.
    // Allow .env.example (safe template).
    if (
      /\.env(\.[a-zA-Z0-9_-]+)?$/.test(LOWER) &&
      !LOWER.endsWith('.env.example')
    ) {
      return 'deny'
    }
    // SSH keys and credential paths.
    if (
      /id_[a-z]*[_-]?(rsa|ed25519|dsa|ecdsa)/.test(LOWER) ||
      /credentials(?:\.json|\.toml|\.yaml)?$/.test(LOWER) ||
      /[/-]secrets?[/-]/.test(LOWER) ||
      /secrets?[\\/]/.test(LOWER)
    ) {
      return 'deny'
    }
  }

  // Walk layers from lowest to highest priority.
  let defaultAction: PermissionAction = 'deny'
  for (const layer of layers) {
    const rules = layer[tool]
    if (!rules) continue

    // Specific patterns first (exact and glob), then wildcard as fallback.
    for (const [pattern, action] of Object.entries(rules)) {
      if (pattern === '*') continue
      if (globMatch(pattern, resource)) {
        return action as PermissionAction
      }
    }
    // Wildcard acts as this layer's default.
    if (rules['*']) {
      defaultAction = rules['*'] as PermissionAction
    }
  }

  return defaultAction
}

// ── Glob pattern matching ───────────────────────────────────────────────────

/**
 * Match a resource string against a glob pattern.
 *
 * Supports: `*` (any chars), `**` (any chars), `?` (single char).
 *
 * For file paths, `*` only matches within one segment (excludes / and \).
 * For command strings (bash, grep), `*` means "one or more argument characters"
 * — it matches non-empty content after the command name (the space after the
 * command is consumed literally, so `git *` matches `git commit` but the exact
 * pattern `git commit` is checked first and wins when present).
 */
function globMatch(pattern: string, resource: string, isCommand = false): boolean {
  // Fast path: exact match.
  if (pattern === resource) return true

  if (isCommand) {
    // For commands, `*` in the pattern means "one or more args after the
    // command". Split on the first space: [command, args].
    const spaceIdx = pattern.indexOf(' ')
    if (spaceIdx !== -1) {
      // Pattern has a space → the part before it is the command name.
      const patCmd = pattern.slice(0, spaceIdx)
      const patArgs = pattern.slice(spaceIdx + 1)
      const resSpaceIdx = resource.indexOf(' ')
      const resCmd = resSpaceIdx === -1 ? resource : resource.slice(0, resSpaceIdx)
      // Command part must match exactly (case-insensitive).
      if (patCmd.toLowerCase() !== resCmd.toLowerCase()) return false
      // Args part: if no `*` in args, match exactly; otherwise use regex with `.+`
      // to require at least one character (at least one argument token).
      if (!patArgs.includes('*') && !patArgs.includes('?')) {
        // No wildcards in args — compare literally.
        const resArgs = resSpaceIdx === -1 ? '' : resource.slice(resSpaceIdx + 1)
        return patArgs === resArgs
      }
      const argsRegex = patArgs
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '{{DS}}')
        .replace(/\*/g, '.+')
        .replace(/\{\{DS\}\}/g, '.*')
        .replace(/\?/g, '.')
      const resArgs = resSpaceIdx === -1 ? '' : resource.slice(resSpaceIdx + 1)
      try {
        return new RegExp(`^${argsRegex}$`, 'i').test(resArgs)
      } catch {
        return false
      }
    }
    // No space in pattern → treat as a simple command name with possible wildcards.
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{DS}}')
      .replace(/\*/g, '.+')
      .replace(/\{\{DS\}\}/g, '.*')
      .replace(/\?/g, '.')
    try {
      return new RegExp(`^${regexPattern}$`, 'i').test(resource)
    } catch {
      return false
    }
  }

  // For file paths: * only matches within one segment.
  const anySegment = '[^/\\\\]*'
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLE_STAR}}')
    .replace(/\*/g, anySegment)
    .replace(/\{\{DOUBLE_STAR\}\}/g, '.*')
    .replace(/\?/g, '.')

  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(resource)
  } catch {
    return false
  }
}

/**
 * Resolve permission for a bash command string.
 *
 * Command patterns use `*` to mean "one or more argument characters" (not
 * literal `*`). Exact patterns (no wildcards) take precedence over glob
 * patterns within the same layer.
 */
export function resolveCommandPermission(
  command: string,
  layers: PermissionRules[],
): PermissionAction {
  let defaultAction: PermissionAction = 'deny'

  for (const layer of layers) {
    const rules = layer.bash
    if (!rules) continue

    // Exact patterns (no wildcard chars) are checked first — they cannot be
    // overridden by a glob pattern in the same layer.
    for (const [pattern, action] of Object.entries(rules)) {
      if (pattern === '*') continue
      if (pattern === command) {
        return action as PermissionAction
      }
    }

    // Glob patterns — evaluate in insertion order, first match wins.
    for (const [pattern, action] of Object.entries(rules)) {
      if (pattern === '*') continue
      if (pattern.includes('*') || pattern.includes('?') || pattern.includes('**')) {
        if (globMatch(pattern, command, true)) {
          return action as PermissionAction
        }
      }
    }

    // Wildcard fallback for this layer.
    if (rules['*']) {
      defaultAction = rules['*'] as PermissionAction
    }
  }

  return defaultAction
}

// ── Default export ──────────────────────────────────────────────────────────

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  permissionProfile: 'workspace_write',
  permissions: BUILTIN_PROFILES.workspace_write,
}
