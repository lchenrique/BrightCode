import { useCallback, useState } from 'react'
import { providerRegistry } from '@/lib/providers/registry'
import type { Project } from '@/lib/projects/store'

type GitResult = { ok: true; stdout: string; stderr: string; code: number } | { ok: false; error: string }

const SYSTEM_PROMPT = `You generate a commit message for the staged/unstaged changes in a git repository.

Rules:
- Output ONLY the commit message. No prose, no preamble, no code fences.
- Use the Conventional Commits format: <type>(<scope>): <subject>
- Allowed types: feat, fix, chore, refactor, docs, style, test, perf, build, ci.
- Subject line: imperative mood, lowercase, no trailing period, max 72 chars.
- If the change set is non-trivial, add a blank line and a short bullet list (max 5 bullets) of the key changes.
- Match the project language: if the user has been writing in Portuguese, reply in Portuguese; otherwise English.
- Never quote large diffs; summarize the intent.`

/**
 * Sends the current working-tree diff to the active provider and returns a
 * streaming generator of commit message tokens. The caller concatenates the
 * tokens and fills the commit-message input as the response streams in.
 */
export function useGenerateCommitMessage(project: Project | null) {
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = useCallback(
    async (params: {
      model: string
      accountId?: string
      onChunk: (text: string) => void
    }) => {
      if (!project) return
      const api = window.electronAPI
      if (!api?.git) {
        setError('Git is only available in the desktop app.')
        return
      }
      setGenerating(true)
      setError(null)
      try {
        // 1. Gather context: the working-tree diff (stat + patch).
        const diffResult: GitResult = await api.git.exec(project.id, [
          'diff',
          '--stat',
        ])
        if (!diffResult.ok) {
          setError(diffResult.error)
          return
        }
        const statText = diffResult.stdout.trim()

        // Per-file diff (truncated per file to keep the prompt small).
        const patchResult: GitResult = await api.git.exec(project.id, [
          'diff',
          '--no-color',
        ])
        const patchText = patchResult.ok
          ? truncatePatch(patchResult.stdout, 200, 2000)
          : ''

        const untrackedResult: GitResult = await api.git.exec(project.id, [
          'ls-files',
          '--others',
          '--exclude-standard',
        ])
        const untracked = untrackedResult.ok
          ? untrackedResult.stdout.trim().split('\n').filter(Boolean).slice(0, 50)
          : []

        const recentLogResult: GitResult = await api.git.exec(project.id, [
          'log',
          '--oneline',
          '-10',
        ])
        const recentLog = recentLogResult.ok ? recentLogResult.stdout.trim() : ''

        const userPrompt = [
          'Generate a commit message for the following changes.',
          '',
          '## Changed files (stat)',
          statText || '(no stat output)',
          '',
          '## Patch (truncated)',
          patchText || '(no patch available)',
          untracked.length > 0
            ? `\n## Untracked files\n${untracked.map((f) => `- ${f}`).join('\n')}`
            : '',
          recentLog
            ? `\n## Recent commits (for style)\n\`\`\`\n${recentLog}\n\`\`\``
            : '',
        ]
          .join('\n')
          .trim()

        // 2. Stream from the provider.
        const stream = providerRegistry.stream(
          params.model,
          {
            model: params.model,
            systemPrompt: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userPrompt }],
            maxTokens: 600,
            temperature: 0.4,
          },
          params.accountId,
        )

        for await (const chunk of stream) {
          if (chunk.type === 'text_delta' && chunk.text) {
            params.onChunk(chunk.text)
          } else if (chunk.type === 'error') {
            throw chunk.error
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setGenerating(false)
      }
    },
    [project],
  )

  return { generate, generating, error }
}

function truncatePatch(patch: string, perFileLines: number, totalLines: number) {
  const lines = patch.split('\n')
  if (lines.length <= totalLines) return patch
  // Cap each file's @@ block at perFileLines
  const out: string[] = []
  let fileLines = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      out.push(line)
      fileLines = 0
      inHunk = false
      continue
    }
    if (line.startsWith('@@')) {
      out.push(line)
      inHunk = true
      fileLines = 0
      continue
    }
    if (!inHunk) {
      out.push(line)
      continue
    }
    if (fileLines >= perFileLines) continue
    out.push(line)
    fileLines += 1
    if (out.length >= totalLines) {
      out.push('… (diff truncated)')
      break
    }
  }
  return out.join('\n')
}
