import { ipcMain } from 'electron'
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { IPC } from '../shared/ipc-channels'

export interface DiscoveredSkill {
  id: string
  name: string
  description: string
  source: 'codex' | 'agents' | 'gemini' | 'opencode' | 'project'
  sourceLabel: string
  folderPath: string
  skillFilePath: string
  author?: string
  version?: string
  tags?: string[]
  content?: string
}

function parseFrontmatter(rawContent: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: {}, body: rawContent }
  }

  const frontmatterStr = match[1] ?? ''
  const body = match[2] ?? ''
  const frontmatter: Record<string, string> = {}

  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      let val = line.slice(colonIdx + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      frontmatter[key] = val
    }
  }

  return { frontmatter, body }
}

async function findSkillFiles(dir: string): Promise<string[]> {
  const results: string[] = []

  async function walk(current: string, depth = 0) {
    if (depth > 4) return
    try {
      const entries = await readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (
            entry.name === 'node_modules' ||
            entry.name === '.git' ||
            entry.name === 'dist' ||
            entry.name === 'build'
          ) {
            continue
          }
          await walk(join(current, entry.name), depth + 1)
        } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
          results.push(join(current, entry.name))
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  await walk(dir)
  return results
}

export function registerSkillsIpc() {
  ipcMain.handle(
    IPC.SKILLS_LIST,
    async (
      _e,
      activeProjectPath?: string,
    ): Promise<DiscoveredSkill[]> => {
      const userHome = homedir()
      const searchTargets: Array<{
        dir: string
        source: DiscoveredSkill['source']
        label: string
      }> = [
        {
          dir: join(userHome, '.codex', 'skills'),
          source: 'codex',
          label: 'Codex System',
        },
        {
          dir: join(userHome, '.agents', 'skills'),
          source: 'agents',
          label: 'Agent Team',
        },
        {
          dir: join(userHome, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
          source: 'gemini',
          label: 'Antigravity / Gemini',
        },
        {
          dir: join(userHome, 'Downloads', 'opencode', 'skills'),
          source: 'opencode',
          label: 'OpenCode Collection',
        },
      ]

      if (activeProjectPath) {
        searchTargets.push(
          {
            dir: join(activeProjectPath, '.codex', 'skills'),
            source: 'project',
            label: 'Project (.codex)',
          },
          {
            dir: join(activeProjectPath, '.gemini', 'skills'),
            source: 'project',
            label: 'Project (.gemini)',
          },
          {
            dir: join(activeProjectPath, '.agents', 'skills'),
            source: 'project',
            label: 'Project (.agents)',
          },
          {
            dir: join(activeProjectPath, '.claude', 'skills'),
            source: 'project',
            label: 'Project (.claude)',
          },
        )
      }

      const skills: DiscoveredSkill[] = []
      const seenPaths = new Set<string>()

      for (const target of searchTargets) {
        try {
          const s = await stat(target.dir)
          if (!s.isDirectory()) continue
        } catch {
          continue
        }

        const skillFiles = await findSkillFiles(target.dir)

        for (const file of skillFiles) {
          if (seenPaths.has(file)) continue
          seenPaths.add(file)

          try {
            const raw = await readFile(file, 'utf-8')
            const { frontmatter, body } = parseFrontmatter(raw)
            const parentFolder = dirname(file)
            const fallbackName = basename(parentFolder)

            const name = frontmatter['name'] || fallbackName
            const description =
              frontmatter['description'] ||
              body
                .split('\n')
                .find((l) => l.trim() && !l.startsWith('#'))
                ?.trim() ||
              'No description available'

            skills.push({
              id: `${target.source}_${fallbackName}_${file}`,
              name,
              description,
              source: target.source,
              sourceLabel: target.label,
              folderPath: parentFolder,
              skillFilePath: file,
              author: frontmatter['author'],
              version: frontmatter['version'],
              tags: frontmatter['tags']
                ? frontmatter['tags'].split(',').map((t) => t.trim())
                : undefined,
            })
          } catch {
            // Ignore unreadable file
          }
        }
      }

      return skills
    },
  )

  ipcMain.handle(
    IPC.SKILLS_READ,
    async (_e, filePath: string): Promise<string> => {
      try {
        return await readFile(filePath, 'utf-8')
      } catch (err) {
        throw new Error(
          `Failed to read skill file: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )

  ipcMain.handle(
    IPC.SKILLS_WRITE,
    async (_e, filePath: string, content: string): Promise<boolean> => {
      try {
        await writeFile(filePath, content, 'utf-8')
        return true
      } catch (err) {
        throw new Error(
          `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    },
  )
}
