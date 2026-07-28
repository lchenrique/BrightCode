/**
 * Thread index — metadata for fast listing and search.
 *
 * The index is stored alongside the JSONL as `<threadId>.index.json`.
 * Writes are atomic: write to a temp file then rename into place.
 *
 * Schema:
 * ```json
 * {
 *   "threadId": "...",
 *   "createdAt": 1234567890,
 *   "updatedAt": 1234567890,
 *   "title": "...",
 *   "turnCount": 5,
 *   "lastSequence": 142,
 *   "activeTurnId": "turn-abc",
 *   "schemaVersion": 2,
 *   "readOnly": false
 * }
 * ```
 */

import { writeFile, readFile, rename, mkdir } from 'fs/promises'
import { dirname, join } from 'path'

export interface ThreadIndex {
  threadId: string
  createdAt: number
  updatedAt: number
  title: string
  turnCount: number
  lastSequence: number
  activeTurnId?: string
  schemaVersion: number
  readOnly: boolean
}

const INDEX_SUFFIX = '.index.json'

function indexPath(threadsDir: string, threadId: string): string {
  return join(threadsDir, `${threadId}${INDEX_SUFFIX}`)
}

/** Atomically write the index for a thread. */
export async function writeThreadIndex(
  threadsDir: string,
  index: ThreadIndex,
): Promise<void> {
  const targetPath = indexPath(threadsDir, index.threadId)
  const tmpPath = targetPath + '.tmp'
  await mkdir(dirname(targetPath), { recursive: true })
  const content = JSON.stringify(index, null, 2)
  await writeFile(tmpPath, content, 'utf8')
  await rename(tmpPath, targetPath)
}

/** Read the index for a single thread. Returns null if absent. */
export async function readThreadIndex(
  threadsDir: string,
  threadId: string,
): Promise<ThreadIndex | null> {
  const path = indexPath(threadsDir, threadId)
  try {
    const content = await readFile(path, 'utf8')
    return JSON.parse(content) as ThreadIndex
  } catch {
    return null
  }
}

/** List all thread ids in the store (reads the filesystem). */
export async function listThreadIds(threadsDir: string): Promise<string[]> {
  const { readdir } = await import('fs/promises')
  let entries: string[]
  try {
    entries = await readdir(threadsDir)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.endsWith('.jsonl'))
    .map((e) => e.replace(/\.jsonl$/, ''))
}

/** Update just the timestamp and lastSequence of an index (append-time update). */
export async function touchThreadIndex(
  threadsDir: string,
  threadId: string,
  seq: number,
  activeTurnId?: string,
): Promise<void> {
  const idx = await readThreadIndex(threadsDir, threadId)
  if (!idx) return
  idx.updatedAt = Date.now()
  idx.lastSequence = seq
  if (activeTurnId !== undefined) idx.activeTurnId = activeTurnId
  await writeThreadIndex(threadsDir, idx)
}

/** Delete both the JSONL and index for a thread. */
export async function deleteThreadFiles(
  threadsDir: string,
  threadId: string,
): Promise<void> {
  const { unlink } = await import('fs/promises')
  const jsonlPath = join(threadsDir, `${threadId}.jsonl`)
  const idxPath = indexPath(threadsDir, threadId)
  try { await unlink(jsonlPath) } catch { /* already gone */ }
  try { await unlink(idxPath) } catch { /* already gone */ }
}
