import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@/lib/projects/store'

export type FileDiffData = {
  /** Old content (HEAD). Empty string for added/untracked files. */
  oldContent: string
  /** New content (working tree). Empty string for deleted files. */
  newContent: string
  /** Pre-parsed unified diff hunks (the `@@ -X,Y +A,B @@` blocks, raw). */
  hunks: string[]
  /** Raw `git diff` text for any custom downstream use. */
  diffText: string
}

type GitResult = { ok: true; stdout: string; stderr: string; code: number } | { ok: false; error: string }

/**
 * Builds the `{oldContent, newContent, hunks}` triple the git-diff-view
 * `<DiffView>` component needs to render a file.
 *
 * For modified/deleted files we run `git diff -- <path>` to get the
 * unified hunks and read the working-tree content from disk.
 * For untracked files we synthesize a fully-`+` diff against an empty
 * old file so the viewer can still render a usable preview.
 * For deleted files we synthesize a fully-`-` diff.
 */
export function useFileDiff(
  project: Project | null,
  filePath: string | null,
  isUntracked: boolean,
  isDeleted: boolean,
) {
  const [data, setData] = useState<FileDiffData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!project || !filePath) {
      setData(null)
      return
    }
    const api = window.electronAPI
    if (!api?.git) {
      setError('Diff is only available in the desktop app.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      // Read the new content from the working tree
      const newResult = await api.workspace.readFile(project.id, filePath)
      const newContent = newResult.ok ? newResult.content : ''

      // Read the old content from HEAD (or git show)
      let oldContent = ''
      const showResult: GitResult = await api.git.exec(project.id, [
        'show',
        `HEAD:${filePath}`,
      ])
      if (showResult.ok) {
        oldContent = showResult.stdout
      }

      if (isUntracked) {
        // Synthesize: every line of new file is `+`
        const lines = newContent.split('\n').filter((l) => l.length > 0)
        const synthesized = [
          `--- /dev/null`,
          `+++ b/${filePath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((line) => `+${line}`),
          '',
        ].join('\n')
        setData({
          oldContent: '',
          newContent,
          hunks: [synthesized],
          diffText: synthesized,
        })
        return
      }

      if (isDeleted) {
        const lines = oldContent.split('\n').filter((l) => l.length > 0)
        const synthesized = [
          `--- a/${filePath}`,
          `+++ /dev/null`,
          `@@ -1,${lines.length} +0,0 @@`,
          ...lines.map((line) => `-${line}`),
          '',
        ].join('\n')
        setData({
          oldContent,
          newContent: '',
          hunks: [synthesized],
          diffText: synthesized,
        })
        return
      }

      // Modified: ask git for the raw hunks
      const diffResult: GitResult = await api.git.exec(project.id, [
        'diff',
        '--',
        filePath,
      ])
      if (!diffResult.ok) {
        setError(diffResult.error)
        return
      }
      const diffText = diffResult.stdout
      // Extract just the hunk blocks for <DiffView data.hunks>
      const hunks = diffText
        .split('\n')
        .reduce<string[]>((acc, line) => {
          if (line.startsWith('@@')) {
            acc.push(line)
          } else if (acc.length > 0) {
            acc[acc.length - 1] += '\n' + line
          }
          return acc
        }, [])

      setData({ oldContent, newContent, hunks, diffText })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [project, filePath, isUntracked, isDeleted])

  useEffect(() => {
    void load()
  }, [load])

  return { data, loading, error, refresh: load }
}
