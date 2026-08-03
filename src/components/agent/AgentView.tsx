import { useState } from 'react'
import { ChatSurface } from '@/components/chat/ChatSurface'
import { ViewTopBar } from '@/components/layout/ViewTopBar'
import { ProgressPanel } from '@/components/task/ProgressPanel'
import { agentStore } from '@/lib/agents'
import { useTask } from '@/hooks/use-tasks'

export function AgentView({
  agentId,
  taskId,
  onOpenAgentConversation,
}: {
  agentId: string
  taskId: string
  onOpenAgentConversation?: (agentId: string) => void
}) {
  const [progressOpen, setProgressOpen] = useState(true)

  const agent = agentStore.list().find((a) => a.id === agentId)
  const task = useTask(taskId)

  if (!agent) {
    return (
      <div className="flex h-full flex-col">
        <ViewTopBar title="Agent" />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground text-[14px]">Agent not found.</p>
        </div>
      </div>
    )
  }

  const sessionTitle = task?.title?.trim() || `New ${agent.name} session`

  // Layout matches TaskView: top bar (shrink-0) + main row (flex-1). The
  // chat owns the only flex-1 column so its input can never get pushed
  // out of the viewport when the user bumps the text-size zoom.
  return (
    <div className="flex h-full flex-col">
      <ViewTopBar
        title={`${agent.name} · ${sessionTitle}`}
        progressOpen={progressOpen}
        onToggleProgress={() => setProgressOpen((o) => !o)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {agent.description?.trim() && (
            <div className="shrink-0 border-b px-6 py-2.5">
              <p className="text-muted-foreground mx-auto max-w-3xl text-[13px] leading-relaxed">
                {agent.description}
              </p>
            </div>
          )}

          <ChatSurface
            taskId={taskId}
            project={null}
            selectedModelOverride={agent.model || task?.selectedModel || undefined}
            systemPromptOverride={agent.systemPrompt || undefined}
            toolFilter={
              agent.tools.length > 0 ? agent.tools : undefined
            }
            onOpenAgentConversation={onOpenAgentConversation}
            agentSessionTaskId={taskId}
          />
        </div>

        {progressOpen && <ProgressPanel />}
      </div>
    </div>
  )
}
