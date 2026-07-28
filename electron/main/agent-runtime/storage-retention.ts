/**
 * Storage retention policy enforcement.
 *
 * Per the architecture plan:
 * - JSONL log: durable until user deletes thread
 * - Auto-compaction: inactive log > 10 MiB OR > 50,000 events → compact to item snapshots
 * - Pre-compaction `.bak` kept until compacted thread has been opened and replayed once
 * - Artifacts: active thread → retained; orphaned → 7 days; archived → 90 days
 * - Artifact cap: 2 GiB global; evict orphaned/archived oldest first
 * - Checkpoints: last 10 mutation turns or 30 days; UI shows when undo is unavailable
 * - Diagnostics: 100 MiB total or 14 days; redact credentials
 */

export const RETENTION = {
  /** Max JSONL size before auto-compaction. */
  JSONL_COMPACT_THRESHOLD_BYTES: 10 * 1024 * 1024, // 10 MiB
  /** Max event count before auto-compaction. */
  JSONL_COMPACT_THRESHOLD_EVENTS: 50_000,
  /** Artifact expiry after last reference (active thread). */
  ARTIFACT_ORPHAN_EXPIRY_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
  /** Artifact expiry for archived threads. */
  ARTIFACT_ARCHIVED_EXPIRY_MS: 90 * 24 * 60 * 60 * 1000, // 90 days
  /** Global artifact budget. */
  ARTIFACT_CAP_BYTES: 2 * 1024 * 1024 * 1024, // 2 GiB
  /** Checkpoint retention: last N mutation turns. */
  CHECKPOINT_TURN_RETENTION: 10,
  /** Checkpoint retention: max age. */
  CHECKPOINT_AGE_RETENTION_MS: 30 * 24 * 60 * 60 * 1000, // 30 days
  /** Diagnostic log rotation: max total size. */
  DIAGNOSTIC_CAP_BYTES: 100 * 1024 * 1024, // 100 MiB
  /** Diagnostic log rotation: max age. */
  DIAGNOSTIC_AGE_RETENTION_MS: 14 * 24 * 60 * 60 * 1000, // 14 days
} as const

export type RetentionConfig = typeof RETENTION

/** Runtime-configurable retention settings (subset of RETENTION). */
export interface RetentionSettings {
  artifactCapBytes?: number
  compactThresholdBytes?: number
  compactThresholdEvents?: number
  checkpointTurnRetention?: number
  checkpointAgeRetentionMs?: number
  diagnosticCapBytes?: number
  diagnosticAgeRetentionMs?: number
}
