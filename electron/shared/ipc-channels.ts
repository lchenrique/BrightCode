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
   * Skills discovery + reading/writing from Codex, Agents, Gemini, OpenCode and project folders.
   */
  SKILLS_LIST: 'skills:list',
  SKILLS_READ: 'skills:read',
  SKILLS_WRITE: 'skills:write',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
