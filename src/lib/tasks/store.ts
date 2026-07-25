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

export type Task = {
  id: string
  /** Owning project id, or null for a "loose" conversation. */
  projectId: string | null
  /** Auto-generated from the first message; user-editable later. */
  title: string
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
  private pendingFirstMessage = new Map<string, string>()

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

  // ── Mutations ─────────────────────────────────────────────────────────

  /**
   * Create a task and prepend it to the list (newest first). Returns the
   * newly-created task so callers can immediately switch to it.
   */
  create(input: { projectId: string | null; title: string }): Task {
    const now = Date.now()
    const task: Task = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
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

  update(id: string, patch: Partial<Pick<Task, 'title' | 'projectId'>>): void {
    this.tasks = this.tasks.map((t) =>
      t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t,
    )
    this.emit()

    if (typeof window !== 'undefined' && window.electronAPI?.tasks) {
      void window.electronAPI.tasks.update(id, patch)
    }
  }

  // ── Pending first message (welcome → task handoff) ───────────────────

  /**
   * Park the first user message so the TaskView can pick it up after
   * the view switch. No emit — pending messages are transient and
   * shouldn't trigger re-renders of subscribers that care about
   * task list state.
   */
  setPendingFirstMessage(taskId: string, message: string): void {
    this.pendingFirstMessage.set(taskId, message)
  }

  /**
   * Read the pending message (without removing). Used by TaskView to
   * decide whether to auto-send on mount.
   */
  peekPendingFirstMessage(taskId: string): string | undefined {
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
