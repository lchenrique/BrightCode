/**
 * WelcomeScreen — the empty-state landing page.
 *
 * Unified hero layout: a brand mark, the headline, a centered chat
 * input, and (if a project is active) a project chip below the input
 * so the user can see which project their next task will be filed
 * under. Submitting the input creates a task in the store and
 * switches the view to it — every "New task" flow lands in a real
 * task that appears in the sidebar under its project.
 *
 * The chat logic itself lives in `ChatSurface`. The welcome screen
 * is just the "compose your first message" surface; once submitted,
 * the task takes over.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { KeyRound, Settings } from 'lucide-react'
import { ChatInput, type ModelGroup } from './ChatInput'
import { ContextBar } from './ContextBar'
import { FileTypeButtons } from './FileTypeButtons'
import { GridBackground } from './GridBackground'
import {
  useAvailableModels,
  useAvailableModelsGrouped,
  useDefaultModel,
} from '@/hooks/use-provider-registry'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { useSettings } from '@/hooks/use-settings'
import { useActiveProject } from '@/hooks/use-projects'
import {
  readLastSelectedModel,
  saveLastSelectedModel,
} from '@/lib/agents/model-preference'

export function WelcomeScreen({
  onCreateTask,
}: {
  /**
   * Called when the user submits a message in the welcome input. The
   * caller is responsible for creating a task, parking the message
   * for the TaskView to auto-send, and switching the view.
   */
  onCreateTask: (
    payload: { text: string; images: import('./ChatInput').AttachedImage[] },
    selectedModel?: string,
    selectedAccountId?: string,
  ) => void
}) {
  const { openSettings } = useSettings()
  const available = useAvailableModels()
  const grouped = useAvailableModelsGrouped()
  const defaultModel = useDefaultModel()
  const activeProject = useActiveProject()
  const hasAnyModel = available.length > 0
  const [selectedModel, setSelectedModel] = useState(readLastSelectedModel)
  const [selectedAccountId, setSelectedAccountId] = useState<string | undefined>(undefined)

  // Grouped model picker data — passed straight to ChatInput in the hero.
  const modelGroups = useMemo<ModelGroup[]>(
    () =>
      grouped.map((g) => ({
        providerId: g.provider.id,
        providerName: g.provider.name,
        hasCredential: g.hasCredential,
        models: g.models,
      })),
    [grouped],
  )

  useEffect(() => {
    setSelectedModel((previous) => {
      if (
        previous &&
        available.some((model) => `${model.provider}/${model.id}` === previous)
      ) {
        return previous
      }
      if (defaultModel) {
        return `${defaultModel.provider}/${defaultModel.id}`
      }
      const first = available[0]
      return first ? `${first.provider}/${first.id}` : previous
    })
  }, [available, defaultModel])

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model)
    saveLastSelectedModel(model)
    setSelectedAccountId(undefined)
  }, [])

  const handleCreateTask = useCallback(
    (payload: { text: string; images: import('./ChatInput').AttachedImage[] }) => {
      if (selectedModel) saveLastSelectedModel(selectedModel)
      onCreateTask(payload, selectedModel || undefined, selectedAccountId)
    },
    [onCreateTask, selectedModel],
  )

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <GridBackground />

      {/* Top-left toggle button when sidebar is offcanvas / collapsed */}
      <div className="absolute top-3 left-3 z-20">
        <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col px-4 sm:px-6 pt-[8vh] sm:pt-[18vh]">
        {/* Top: centered group (brand mark, headline, input) */}
        <div className="flex w-full flex-col items-center">
          <div className="border-border/60 bg-card/40 mb-6 sm:mb-10 flex h-12 w-12 sm:h-14 sm:w-14 items-center justify-center rounded-xl border backdrop-blur">
            <BrandMark />
          </div>

          <h1 className="text-foreground text-center text-2xl sm:text-[28px] font-semibold tracking-tight">
            BrightCode makes your work easier.
          </h1>

          <div className="mt-6 sm:mt-8 w-full">
            {hasAnyModel ? (
              <ChatInput
                modelGroups={modelGroups}
                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                onSend={handleCreateTask}
                emptyModelMessage="Add a provider in Settings"
                autoFocus
              />
            ) : (
              <Button
                onClick={openSettings}
                variant="outline"
                className="w-full"
              >
                <Settings className="size-3.5" />
                Open Settings to add a provider
              </Button>
            )}
          </div>

          {!hasAnyModel && (
            <div className="border-border/60 bg-card/40 mt-6 flex w-full items-center justify-between gap-4 rounded-xl border px-4 py-3 text-[13px]">
              <div className="text-muted-foreground flex items-start gap-2">
                <KeyRound className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  No providers configured yet. Add one in{' '}
                  <strong className="text-foreground/90 font-medium">
                    Settings → Connection
                  </strong>{' '}
                  to start chatting.
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={openSettings}>
                <Settings className="size-3.5" />
                Open Settings
              </Button>
            </div>
          )}

          {/* Context bar — workspace / mode / branch dropdowns. */}
          {hasAnyModel && activeProject && <ContextBar />}
        </div>

        {/* Bottom: file type buttons (always available, no project required) */}
        <div className="mt-6 sm:mt-10 flex w-full flex-col items-center gap-3">
          <FileTypeButtons />
        </div>
      </div>
    </div>
  )
}

function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="text-foreground size-7"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M7 9h4M7 13h7M7 17h10" />
    </svg>
  )
}


