import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatSurface } from '@/components/chat/ChatSurface'
import { ViewTopBar } from '@/components/layout/ViewTopBar'
import { ProgressPanel } from '@/components/task/ProgressPanel'
import { agentStore } from '@/lib/agents'

export function AgentView({
  agentName,
  emoji,
}: {
  agentName: string
  emoji: string
}) {
  const [progressOpen, setProgressOpen] = useState(true)

  const agent = agentStore
    .list()
    .find((a) => a.name === agentName && a.emoji === emoji)

  if (!agent) {
    return (
      <div className="flex h-full flex-col">
        <ViewTopBar title={agentName} />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted-foreground text-[14px]">Agent not found.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ViewTopBar
        title={agentName}
        progressOpen={progressOpen}
        onToggleProgress={() => setProgressOpen((o) => !o)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex max-w-3xl flex-col px-6 pt-4 pb-2">
              <span className="text-muted-foreground text-[13px] leading-relaxed">
                {agent.description}
              </span>
            </div>
          </ScrollArea>

          <ChatSurface
            taskId={`agent-${agent.id}`}
            selectedModelOverride={agent.model || undefined}
            systemPromptOverride={agent.systemPrompt || undefined}
            toolFilter={
              agent.tools.length > 0 ? agent.tools : undefined
            }
          />
        </div>

        {progressOpen && <ProgressPanel />}
      </div>
    </div>
  )
}
