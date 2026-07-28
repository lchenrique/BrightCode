import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project } from '@/lib/projects/store'

export type GitChangeType = 'M' | 'A' | 'D' | 'R' | 'C' | '?' | '!'

export type GitChange = {
  /** One-letter status code: M=modified, A=added, D=deleted, ?=untracked, etc. */
  type: GitChangeType
  /** File path relative to repo root. */
  path: string
}

export type GitStatus = {
  branch: string
  changes: GitChange[]
  ahead: number
  behind: number
}

type GitResult = { ok: true; stdout: string; stderr: string; code: number } | { ok: false; error: string }

function parsePorcelain(stdout: string, currentBranch: string): GitStatus {
  const lines = stdout.split('\n').filter(Boolean)
  const changes: GitChange[] = []
  let ahead = 0
  let behind = 0

  for (const line of lines) {
    if (line.startsWith('##')) {
      // ## branch...remote [ahead N] [behind M]
      const branchMatch = line.match(/^## (.+?)(?:\.\.\.|$)/)
      if (branchMatch) currentBranch = branchMatch[1]
      if (line.includes('ahead ')) {
        const m = line.match(/ahead (\d+)/)
        if (m) ahead = Number(m[1])
      }
      if (line.includes('behind ')) {
        const m = line.match(/behind (\d+)/)
        if (m) behind = Number(m[1])
      }
      continue
    }
    // XY filename
    const xy = line.slice(0, 2).trim()
    const path = line.slice(3).trim()
    // For rename/copy: "R100\told -> new"
    const displayPath = path.includes(' -> ') ? path.split(' -> ').pop()!.trim() : path
    if (xy === '??') {
      changes.push({ type: '?', path: displayPath })
    } else if (xy === '!!') {
      changes.push({ type: '!', path: displayPath })
    } else if (xy.length > 0 && xy !== '  ') {
      // Index status takes priority
      const first = xy[0]
      if (first !== ' ' && first !== '?') {
        changes.push({ type: first as GitChangeType, path: displayPath })
      } else if (xy[1] !== ' ') {
        changes.push({ type: xy[1] as GitChangeType, path: displayPath })
      }
    }
  }

  return { branch: currentBranch, changes, ahead, behind }
}

export function useGit(project: Project | null) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    if (!project) return
    const api = window.electronAPI
    if (!api?.git) {
      setError('Git is only available in the desktop app.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      // Fetch branch and status in a single call via status --porcelain -b
      const result: GitResult = await api.git.exec(project.id, [
        'status',
        '--porcelain',
        '-b',
      ])
      if (!result.ok) {
        setError(result.error)
        setStatus(null)
        return
      }

      // Also get ahead/behind count via rev-list
      const branchResult: GitResult = await api.git.exec(project.id, [
        'branch',
        '--show-current',
      ])
      const branch = branchResult.ok
        ? branchResult.stdout.trim()
        : 'unknown'

      const parsed = parsePorcelain(result.stdout, branch)
      setStatus(parsed)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [project])

  // Auto-refresh every 5s while the project exists
  useEffect(() => {
    if (!project) {
      setStatus(null)
      setError(null)
      return
    }

    void refresh()

    timerRef.current = setInterval(() => {
      void refresh()
    }, 5000)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [project, refresh])

  const commit = useCallback(
    async (message: string): Promise<boolean> => {
      if (!project || !message.trim()) return false
      const api = window.electronAPI
      if (!api?.git) return false

      setCommitting(true)
      setError(null)
      try {
        // Stage all
        const addResult: GitResult = await api.git.exec(project.id, ['add', '-A'])
        if (!addResult.ok) {
          setError(addResult.error)
          return false
        }

        const commitResult: GitResult = await api.git.exec(project.id, [
          'commit',
          '-m',
          message.trim(),
        ])
        if (!commitResult.ok) {
          setError(commitResult.error)
          return false
        }

        void refresh()
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setCommitting(false)
      }
    },
    [project, refresh],
  )

  const push = useCallback(async (): Promise<boolean> => {
    if (!project) return false
    const api = window.electronAPI
    if (!api?.git) return false

    setPushing(true)
    setError(null)
    try {
      const result: GitResult = await api.git.exec(project.id, ['push'])
      if (!result.ok) {
        setError(result.error)
        return false
      }
      void refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setPushing(false)
    }
  }, [project, refresh])

  return {
    status,
    loading,
    error,
    committing,
    pushing,
    refresh,
    commit,
    push,
  }
}
