/**
 * Tasks store — the renderer's reactive view of the user's task/conversation
 * registry. In-memory only for now (Phase 1). The shape is designed to be
 * backed by electron-store + IPC in Phase 2 without breaking the public API.
 *
 * A task is a single conversation thread. It MAY belong to a project
 * (`projectId` set) or be a "loose" conversation without a project
 * context (`projectId === null`). Tasks appear in the sidebar under
 * their project, or in a "Loose" group when unparented.
 *
 * Note: messages are NOT stored here — they live in `ChatSurface` state
 * for now. The task only owns the metadata (id, title, project, dates).
 * Phase 2 will move messages into the main process so they survive
 * reloads and can be restored when re-opening a task.
 */

export type ProgressStepStatus = 'pending' | 'running' | 'completed' | 'failed'

export type ProgressStep = {
  id: string
  title: string
  status: ProgressStepStatus
  /** When the step started; used to show a "1m ago" hint later. */
  startedAt?: number
  finishedAt?: number
  /** Optional detail line (e.g. file path, command). */
  detail?: string
}

export type Task = {
  id: string
  /** Owning project id, or null for a "loose" conversation. */
  projectId: string | null
  /**
   * Owning Teams-agent id, or undefined for orchestrator (Bright)
   * conversations. When set, the task is a session of that agent and
   * the sidebar groups it under the agent's section, not the project.
   */
  agentId?: string
  /** Auto-generated from the first message; user-editable later. */
  title: string
  /** Provider/model selection restored whenever this conversation is opened. */
  selectedModel?: string
  /** Account selection restored whenever this conversation is opened. */
  selectedAccountId?: string
  /**
   * Steps that the agent is currently working on (tool calls, sub-tasks,
   * etc). The Environmental Information "Progress" section reads from
   * this list. Reset to `[]` when a new user turn starts.
   */
  progress?: ProgressStep[]
  createdAt: number
  updatedAt: number
}

type Listener = () => void

class TasksStore {
  private tasks: Task[] = []
  private listeners = new Set<Listener>()
  private version = 0

  // Transient: when a task is created from the welcome screen, the
  // first user message is parked here keyed by task id. The TaskView
  // reads it on mount, auto-sends it, and clears the entry.
  // Holds the full submit payload (text + attached images) so multimodal
  // first messages survive the welcome → task view handoff.
  private pendingFirstMessage = new Map<
    string,
    { text: string; images: Array<{ id: string; data: string; mediaType: string; name: string; size: number }> }
  >()

  constructor() {
    this.initFromElectron()
  }

  private initFromElectron() {
    if (typeof window !== 'undefined' && window.electronAPI?.tasks) {
      void window.electronAPI.tasks.list().then((loaded) => {
        if (Array.isArray(loaded)) {
          this.tasks = loaded
          this.emit()
        }
      })

      window.electronAPI.tasks.onChanged(() => {
        void window.electronAPI?.tasks.list().then((reloaded) => {
          if (Array.isArray(reloaded)) {
            this.tasks = reloaded
            this.emit()
          }
        })
      })
    }
  }

  // ── Read access (stable references for `useSyncExternalStore`) ───────

  getTasks(): Task[] {
    return this.tasks
  }

  getTask(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  getTasksByProject(projectId: string | null): Task[] {
    return this.tasks.filter((t) => t.projectId === projectId)
  }

  /** All sessions of a Teams agent, newest first. */
  getTasksByAgent(agentId: string): Task[] {
    return this.tasks
      .filter((t) => t.agentId === agentId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Latest session of a Teams agent, or undefined. */
  getLatestAgentTask(agentId: string): Task | undefined {
    return this.getTasksByAgent(agentId)[0]
  }

  // ── Mutations ─────────────────────────────────────────────────────────

  /**
   * Create a task and prepend it to the list (newest first). Returns the
   * newly-created task so callers can immediately switch to it.
   */
  create(input: {
    projectId: string | null
    title: string
    selectedModel?: string
    selectedAccountId?: string
    agentId?: string
  }): Task {
    const now = Date.now()
    const task: Task = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
      selectedModel: input.selectedModel,
      selectedAccountId: input.selectedAccountId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      createdAt: now,
      updatedAt: now,
    }
    this.tasks = [task, ...this.tasks]
    this.emit()

    if (typeof window !== 'undefined' && window.electronAPI?.tasks) {
      void window.electronAPI.tasks.create(task)
    }
    return task
  }

  remove(id: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this.pendingFirstMessage.delete(id)
    this.emit()

    if (typeof window !== 'undefined' && window.electronAPI?.tasks) {
      void window.electronAPI.tasks.remove(id)
    }
  }

  update(
    id: string,
    patch: Partial<Pick<Task, 'title' | 'projectId' | 'selectedModel' | 'selectedAccountId'>>,
  ): void {
    this.tasks = this.tasks.map((t) =>
      t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t,
    )
    this.emit()

    if (typeof window !== 'undefined' && window.electronAPI?.tasks) {
      void window.electronAPI.tasks.update(id, patch)
    }
  }

  // ── Progress tracking (in-memory, per session) ─────────────────────────

  /** Replace the whole progress list for a task. Pass `[]` to clear. */
  setProgress(id: string, steps: ProgressStep[]): void {
    this.tasks = this.tasks.map((t) =>
      t.id === id ? { ...t, progress: steps, updatedAt: Date.now() } : t,
    )
    this.emit()
  }

  /** Append a step (defaults to `pending` status) and return its id. */
  addProgress(id: string, title: string, detail?: string): string | null {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return null
    const step: ProgressStep = {
      id: crypto.randomUUID(),
      title,
      status: 'pending',
      startedAt: Date.now(),
      ...(detail ? { detail } : {}),
    }
    const next = [...(task.progress ?? []), step]
    this.tasks = this.tasks.map((t) =>
      t.id === id ? { ...t, progress: next, updatedAt: Date.now() } : t,
    )
    this.emit()
    return step.id
  }

  /** Mark an existing step as `running`, `completed`, or `failed`. */
  setProgressStatus(
    id: string,
    stepId: string,
    status: ProgressStepStatus,
  ): void {
    this.tasks = this.tasks.map((t) => {
      if (t.id !== id) return t
      const next = (t.progress ?? []).map((s) =>
        s.id === stepId
          ? {
              ...s,
              status,
              ...(status === 'running' && !s.startedAt
                ? { startedAt: Date.now() }
                : {}),
              ...(status === 'completed' || status === 'failed'
                ? { finishedAt: Date.now() }
                : {}),
            }
          : s,
      )
      return { ...t, progress: next, updatedAt: Date.now() }
    })
    this.emit()
  }

  /** Clear the progress list for a task. */
  clearProgress(id: string): void {
    this.tasks = this.tasks.map((t) =>
      t.id === id ? { ...t, progress: [], updatedAt: Date.now() } : t,
    )
    this.emit()
  }

  // ── Pending first message (welcome → task handoff) ───────────────────

  /**
   * Park the first user message (text + attached images) so the
   * TaskView can pick it up after the view switch. No emit — pending
   * messages are transient and shouldn't trigger re-renders of
   * subscribers that care about task list state.
   */
  setPendingFirstMessage(
    taskId: string,
    payload: { text: string; images: Array<{ id: string; data: string; mediaType: string; name: string; size: number }> },
  ): void {
    this.pendingFirstMessage.set(taskId, payload)
  }

  /**
   * Read the pending payload (without removing). Used by TaskView to
   * decide whether to auto-send on mount.
   */
  peekPendingFirstMessage(
    taskId: string,
  ):
    | { text: string; images: Array<{ id: string; data: string; mediaType: string; name: string; size: number }> }
    | undefined {
    return this.pendingFirstMessage.get(taskId)
  }

  /** Clear the pending message after the TaskView has consumed it. */
  clearPendingFirstMessage(taskId: string): void {
    this.pendingFirstMessage.delete(taskId)
  }

  // ── Subscription ──────────────────────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getVersion(): number {
    return this.version
  }

  private emit(): void {
    this.version++
    for (const l of this.listeners) l()
  }
}

export const tasksStore = new TasksStore()

/**
 * Derive a short title from the first user message. The first line of the
 * message, capped at ~50 chars on a word boundary. Keeps the sidebar tidy
 * without making titles too long to scan.
 */
export function deriveTaskTitle(firstMessage: string): string {
  const firstLine = firstMessage.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine.length <= 50) return firstLine || 'New task'
  // Truncate on the last word boundary ≤ 47 chars so we can append "…"
  const cut = firstLine.slice(0, 47)
  const lastSpace = cut.lastIndexOf(' ')
  const base = lastSpace > 20 ? cut.slice(0, lastSpace) : cut
  return base + '…'
}
