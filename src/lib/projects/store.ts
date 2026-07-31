/**
 * Projects store — the renderer's reactive view of the user's project
 * registry. Persisted in the main process via electron-store; this module
 * just hydrates from the main process and re-emits on broadcasts.
 *
 * The shape mirrors `electron/main/projects.ts` so the IPC boundary is
 * the only place that does the conversion.
 */

export type Project = {
  id: string
  label: string
  /** Absolute, realpath-resolved path to the project root. */
  path: string
  createdAt: number
}

export type DirEntry = { name: string; path: string }

type Listener = () => void

class ProjectsStore {
  private projects: Project[] = []
  private activeId: string | null = null
  private listeners = new Set<Listener>()
  private version = 0
  private hydrated = false
  private unsubscribeMain: (() => void) | null = null

  /** Lazy subscription to the main process `PROJECTS_CHANGED` broadcast. */
  private bindMain(): void {
    if (this.unsubscribeMain) return
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.projects?.onChanged) return
    this.unsubscribeMain = api.projects.onChanged(() => {
      void this.refresh()
    })
  }

  /** Pull the latest list + active id from the main process. */
  async refresh(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.projects) {
      // Running in plain browser dev — no projects backend. Mark hydrated
      // so the UI doesn't spin forever, but stay empty.
      if (!this.hydrated) {
        this.hydrated = true
        this.emit()
      }
      return
    }
    try {
      const [projects, active] = await Promise.all([
        api.projects.list(),
        api.projects.getActive(),
      ])
      this.projects = projects ?? []
      this.activeId = active?.id ?? null
      this.hydrated = true
      this.emit()
    } catch (err) {
      console.error('[projects] refresh failed', err)
    }
  }

  /** First-time hydration. Call once from `main.tsx` before render. */
  async hydrate(): Promise<void> {
    this.bindMain()
    await this.refresh()
  }

  // ── Mutations ─────────────────────────────────────────────────────────

  async add(path: string, label?: string): Promise<
    { ok: true; project: Project } | { ok: false; error: string }
  > {
    const api = window.electronAPI?.projects
    if (!api) return { ok: false, error: 'Projects backend not available' }
    const result = await api.add(path, label)
    // Refresh on both branches — a rejected add (already-present
    // path) still leaves the backend authoritative, and the UI may
    // have diverged from it during a partial-failure window.
    await this.refresh()
    return result
  }

  async remove(id: string): Promise<{ ok: boolean; error?: string }> {
    const api = window.electronAPI?.projects
    if (!api) return { ok: false, error: 'Projects backend not available' }
    const result = await api.remove(id)
    if (result.ok) await this.refresh()
    return result
  }

  async setActive(id: string | null): Promise<void> {
    const api = window.electronAPI?.projects
    if (!api) return
    await api.setActive(id)
    // The main process broadcasts the change, so refresh() will be called
    // via the onChanged subscription — but we also call it directly so the
    // UI updates even before the broadcast arrives.
    await this.refresh()
  }

  // ── Read access (stable references for `useSyncExternalStore`) ───────

  getProjects(): Project[] {
    return this.projects
  }

  getActiveId(): string | null {
    return this.activeId
  }

  getActive(): Project | null {
    if (!this.activeId) return null
    return this.projects.find((p) => p.id === this.activeId) ?? null
  }

  isHydrated(): boolean {
    return this.hydrated
  }

  getVersion(): number {
    return this.version
  }

  // ── Subscription ──────────────────────────────────────────────────────

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    this.version++
    for (const l of this.listeners) l()
  }
}

export const projectsStore = new ProjectsStore()
