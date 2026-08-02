/**
 * Agent conversation transcript — every Teams agent has its own chat
 * (`taskId === "agent-<id>"`). When the orchestrator (Bright) delegates
 * work to a Teams agent, the exchange is recorded in the agent's own
 * transcript so the user can open the agent from the sidebar and see
 * everything that happened — same as a real 1:1 chat between two
 * agents. The user can also send messages directly to any agent.
 */
import type { AgentDefinition } from './store'

/** Stable task id for an agent's own conversation. */
export function agentTaskId(agent: Pick<AgentDefinition, 'id'>): string {
  return `agent-${agent.id}`
}

/** Returns the agent id embedded in an agent taskId, or null. */
export function parseAgentTaskId(taskId: string | null | undefined): string | null {
  if (!taskId) return null
  const match = /^agent-(.+)$/.exec(taskId)
  return match?.[1] ?? null
}

export type AgentTranscriptMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error'
  content: string
  thinking?: string
  model?: string
  toolCalls?: Array<{ id: string; name: string; input: unknown }>
  toolResultSummary?: string
  toolError?: boolean
  toolStopped?: boolean
  isAgentResult?: boolean
  agentName?: string
  agentAvatarSeed?: string
  agentTaskId?: string
  /** When the message was produced by a peer agent (e.g. Bright), this
   *  records the peer's name so the agent's chat can label it. */
  peerName?: string
  peerAvatarSeed?: string
  createdAt: number
}

export async function readAgentTranscript(
  agentId: string,
): Promise<AgentTranscriptMessage[]> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api?.tasks) return []
  const raw = await api.tasks.getMessages<AgentTranscriptMessage>(
    agentTaskId({ id: agentId }),
  )
  return Array.isArray(raw) ? raw : []
}

export async function writeAgentTranscript(
  agentId: string,
  messages: AgentTranscriptMessage[],
): Promise<void> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!api?.tasks) return
  await api.tasks.saveMessages(
    agentTaskId({ id: agentId }),
    messages as unknown as unknown[],
  )
}

export async function appendAgentTranscript(
  agentId: string,
  next: AgentTranscriptMessage[],
): Promise<AgentTranscriptMessage[]> {
  const existing = await readAgentTranscript(agentId)
  const merged = [...existing, ...next]
  await writeAgentTranscript(agentId, merged)
  return merged
}
