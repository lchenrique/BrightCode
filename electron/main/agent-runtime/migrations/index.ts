/**
 * Version migrations for thread event logs.
 *
 * Each migration is a streaming rewrite from an old version to a new one.
 * The rewrite goes to a temp file; on success it replaces the original and
 * the original is kept as `.bak` for one release cycle.
 *
 * IMPORTANT: An unknown schema version (future app) opens the log read-only.
 * We never rewrite a log into an older version.
 */

import { readFile } from 'fs/promises'
import { RuntimeEvent, RUNTIME_SCHEMA_VERSION } from '../../../shared/agent-protocol'

/** A single migration step. */
export interface Migration {
  readonly fromVersion: number
  readonly toVersion: number
  /** Streaming rewrite: read from input path, write transformed events to output path. */
  apply(inputPath: string, outputPath: string): Promise<void>
}

/** Registry of all known migrations, sorted by fromVersion ASC. */
const migrations: Migration[] = [
  // v1→v2: initial runtime schema
  // Add v1→v2 migration here when needed.
]

/**
 * Detect the schema version of a JSONL file by reading the first line.
 * Returns null if the file is empty or unreadable.
 */
export async function detectSchemaVersion(filePath: string): Promise<number | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    const firstLine = content.split('\n')[0].trim()
    if (!firstLine) return null
    const event = JSON.parse(firstLine) as RuntimeEvent
    return event.schemaVersion ?? null
  } catch {
    return null
  }
}

/**
 * Run any pending migrations for a thread log.
 *
 * Strategy:
 *  1. Detect current file version.
 *  2. If version === RUNTIME_SCHEMA_VERSION → no-op.
 *  3. If version > RUNTIME_SCHEMA_VERSION → mark read-only, skip.
 *  4. If version < RUNTIME_SCHEMA_VERSION → apply all missing migrations in order.
 *
 * Returns true if migration was run; false if file is already current or is
 * newer (read-only).
 */
export async function runMigrations(
  filePath: string,
): Promise<{ migrated: boolean; readOnly: boolean }> {
  const version = await detectSchemaVersion(filePath)
  if (version === null) return { migrated: false, readOnly: false }
  if (version === RUNTIME_SCHEMA_VERSION) return { migrated: false, readOnly: false }
  if (version > RUNTIME_SCHEMA_VERSION) {
    // Future version — mark read-only and skip.
    return { migrated: false, readOnly: true }
  }

  // version < RUNTIME_SCHEMA_VERSION — apply migrations in order
  const pending = migrations
    .filter((m) => m.fromVersion >= version && m.toVersion <= RUNTIME_SCHEMA_VERSION)
    .sort((a, b) => a.fromVersion - b.fromVersion)

  for (const migration of pending) {
    const tmpPath = filePath + '.migrating'
    await migration.apply(filePath, tmpPath)
    // atomic rename
    const { rename, unlink } = await import('fs/promises')
    try {
      await rename(tmpPath, filePath)
    } catch (err) {
      // If rename fails, remove the temp file and report failure
      try { await unlink(tmpPath) } catch { /* ignore */ }
      throw err
    }
  }

  return { migrated: true, readOnly: false }
}
