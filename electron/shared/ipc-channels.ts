/**
 * Shared IPC channel constants. Used by main, preload, and renderer so
 * there is one source of truth for the auth-store bridge.
 */

export const IPC = {
  AUTH_GET: 'auth:get',
  AUTH_SET: 'auth:set',
  AUTH_REMOVE: 'auth:remove',
  AUTH_HAS: 'auth:has',
  AUTH_LIST: 'auth:list',
  AUTH_CLEAR: 'auth:clear',
  /** Main → renderer broadcast when credentials change. */
  AUTH_CHANGED: 'auth:changed',

  /** Detect a single CLI by provider id (e.g. 'openai' → Codex). */
  CLI_DETECT: 'cli:detect',
  /** Detect all supported CLIs at once. */
  CLI_DETECT_ALL: 'cli:detect-all',

  /** OAuth login flow via local HTTP server + PKCE. */
  OAUTH_START: 'oauth:start',
  OAUTH_CANCEL: 'oauth:cancel',

  /**
   * Renderer → main. Forwards a `console.log/error/warn` call from the
   * renderer process to the main process stdout. Useful for surfacing
   * errors during dev without opening DevTools. No-op in production.
   */
  RENDERER_LOG: 'renderer:log',

  /**
   * Provider streaming over IPC. The main process does the actual fetch
   * (no CORS, can use OS keyring creds, can retry), then streams chunks
   * back via `webContents.send`. Each request is keyed by `requestId`.
   *
   *   renderer → main:  invoke(PROVIDER_STREAM_START) → { requestId }
   *   main → renderer:  send(PROVIDER_STREAM_CHUNK + requestId) → chunk
   *                     send(PROVIDER_STREAM_END + requestId)   → done
   *                     send(PROVIDER_STREAM_ERROR + requestId)  → error
   *   renderer → main:  send(PROVIDER_STREAM_CANCEL + requestId) → abort
   */
  PROVIDER_STREAM_START: 'provider:stream-start',
  PROVIDER_STREAM_CANCEL: 'provider:stream-cancel',
  PROVIDER_STREAM_CHUNK: 'provider:stream-chunk',
  PROVIDER_STREAM_END: 'provider:stream-end',
  PROVIDER_STREAM_ERROR: 'provider:stream-error',

  /**
   * Project registry. The renderer keeps a reactive cache of `projects`
   * + `activeProjectId`; the main process owns the persistent store
   * (electron-store). `PROJECTS_CHANGED` is the main → renderer broadcast
   * so all open windows pick up add/remove/set-active.
   */
  PROJECTS_LIST: 'projects:list',
  PROJECTS_ADD: 'projects:add',
  PROJECTS_REMOVE: 'projects:remove',
  PROJECTS_SET_ACTIVE: 'projects:set-active',
  PROJECTS_GET_ACTIVE: 'projects:get-active',
  PROJECTS_CHANGED: 'projects:changed',

  /**
   * Filesystem ops used by the project picker + (later) agent tools.
   * All paths are absolute and validated against the active project root
   * before mutating anything.
   */
  FS_HOME: 'fs:home',
  FS_DEFAULT_PROJECTS_DIR: 'fs:default-projects-dir',
  FS_LIST_DIRS: 'fs:list-dirs',
  FS_BROWSE: 'fs:browse',
  FS_VALIDATE: 'fs:validate',
  FS_CLONE: 'fs:clone',
  FS_CREATE_DIR: 'fs:create-dir',
  /** Pops the OS file picker. Returns the absolute path of the chosen
   *  file, or null if the user cancelled. Used by the agent team
   *  creator to seed a custom agent from a markdown file on disk. */
  FS_BROWSE_FILE: 'fs:browse-file',
  FS_PROJECT_TREE: 'fs:project-tree',
  FS_PROJECT_READ: 'fs:project-read',
  FS_PROJECT_WRITE: 'fs:project-write',
  FS_PROJECT_OPEN: 'fs:project-open',

  /**
   * Task / Conversation persistence via electron-store.
   */
  TASKS_LIST: 'tasks:list',
  TASKS_CREATE: 'tasks:create',
  TASKS_REMOVE: 'tasks:remove',
  TASKS_UPDATE: 'tasks:update',
  TASKS_GET_MESSAGES: 'tasks:get-messages',
  TASKS_SAVE_MESSAGES: 'tasks:save-messages',
  TASKS_CHANGED: 'tasks:changed',

  /**
   * Agent tools. The renderer asks the main process to execute a file
   * operation (read, write, edit, list, search) against the active
   * project. The main process enforces the sandbox.
   */
  TOOL_EXECUTE: 'tool:execute',

  /**
   * Bash tool approval flow. When the model calls the `bash` tool, the
   * main process needs the user's explicit OK before running an
   * arbitrary shell command. Main sends REQUEST (with `approvalId`),
   * renderer shows a modal, user clicks Approve/Deny, renderer sends
   * RESPOND with the same `approvalId`. The main process keeps the
   * pending request in a Map keyed by `approvalId` and resolves the
   * caller's Promise when the response arrives.
   */
  TOOL_BASH_APPROVAL_REQUEST: 'tool:bash-approval-request',
  TOOL_BASH_APPROVAL_RESPOND: 'tool:bash-approval-respond',

  /**
   * Skills discovery + reading/writing from Codex, Agents, Gemini, OpenCode and project folders.
   */
  SKILLS_LIST: 'skills:list',
  SKILLS_READ: 'skills:read',
  SKILLS_WRITE: 'skills:write',

  /** Integrated project terminal (PTY) lifecycle and streaming. */
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_EXIT: 'terminal:exit',

  /**
   * Multi-account provider support. The renderer uses ACCOUNTS_* channels
   * to CRUD per-provider accounts; the main process persists them under
   * the new `accounts` key (keeping the old `credentials` key for backward
   * compat during migration).
   */
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_LIST_ALL: 'accounts:list-all',
  ACCOUNTS_GET: 'accounts:get',
  ACCOUNTS_ADD: 'accounts:add',
  ACCOUNTS_UPDATE: 'accounts:update',
  ACCOUNTS_REMOVE: 'accounts:remove',
  ACCOUNTS_SET_ACTIVE: 'accounts:set-active',
  ACCOUNTS_GET_ACTIVE: 'accounts:get-active',
  ACCOUNTS_LIST_ACTIVE: 'accounts:list-active',
  /** Main → renderer broadcast when accounts change. */
  ACCOUNTS_CHANGED: 'accounts:changed',

  /**
   * Agent team definitions. The renderer uses AGENTS_* channels to
   * CRUD agent definitions; the main process persists them under the
   * `agents` key in electron-store.
   */
  AGENTS_LIST: 'agents:list',
  AGENTS_GET: 'agents:get',
  AGENTS_ADD: 'agents:add',
  AGENTS_UPDATE: 'agents:update',
  AGENTS_REMOVE: 'agents:remove',
  /** Main → renderer broadcast when agents change. */
  AGENTS_CHANGED: 'agents:changed',

  /**
   * Usage tracking. The renderer records usage events and reads summaries;
   * the main process persists them under the `usage` and `quota` keys.
   */
  USAGE_RECORD: 'usage:record',
  USAGE_GET_HISTORY: 'usage:get-history',
  USAGE_GET_ALL_HISTORY: 'usage:get-all-history',
  USAGE_GET_SUMMARIES: 'usage:get-summaries',
  USAGE_SET_QUOTA: 'usage:set-quota',
  USAGE_GET_QUOTA: 'usage:get-quota',
  USAGE_GET_ALL_QUOTAS: 'usage:get-all-quotas',
  USAGE_FETCH_CODEX: 'usage:fetch-codex',
  USAGE_READ_CODEX_LOCAL: 'usage:read-codex-local',
  /** Generic server-side fetch for quota endpoints (avoids renderer CORS). */
  USAGE_FETCH_QUOTA: 'usage:fetch-quota',
  USAGE_CLEAR: 'usage:clear',
  /** Main → renderer broadcast when usage or quota data changes. */
  USAGE_CHANGED: 'usage:changed',

  /**
   * Git operations for the Environmental Info panel.
   * Renderer → main: invoke(GIT_EXEC, projectId, args[]) → GitResult
   * Spawns `git` in the project root, no shell, returns { ok, stdout, stderr, code }.
   */
  GIT_EXEC: 'git:exec',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
