import { useState } from 'react'
import { ChevronDown, Signal } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatInput } from '@/components/home/ChatInput'
import { ViewTopBar } from '@/components/layout/ViewTopBar'
import { ProgressPanel } from '@/components/task/ProgressPanel'

/**
 * Agent direct-chat view — large emoji persona, PT-BR intro paragraphs,
 * "Connect to IM" action and the progress panel in its empty state.
 */
export function AgentView({
  agentName,
  emoji,
}: {
  agentName: string
  emoji: string
}) {
  const [progressOpen, setProgressOpen] = useState(true)

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
            <div className="mx-auto flex max-w-3xl flex-col px-6 py-6">
              {/* Meta row */}
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground mx-auto mb-8 flex items-center gap-1 text-[12px] transition-colors"
                onClick={() => console.log('[agent] toggle activity')}
              >
                <span>Thought 2 time(s), Viewed 1 file(s)</span>
                <ChevronDown className="size-3.5" />
              </button>

              {/* Persona message */}
              <div className="flex flex-col gap-4">
                <span className="flex size-10 items-center justify-center text-3xl" aria-hidden>
                  {emoji}
                </span>

                <div className="text-foreground/85 flex flex-col gap-3 text-[14px] leading-6">
                  <p className="text-foreground font-semibold">
                    Bora. Backend é comigo.
                  </p>
                  <p>
                    Sou o {agentName}, especialista em Node.js, APIs REST e
                    integrações. Posso assumir endpoints, filas, autenticação e
                    os testes de integração do projeto — você fica com a visão
                    de produto que eu cuido da engenharia.
                  </p>
                  <p>
                    Me diz o que você precisa: eu desenho a arquitetura, escrevo
                    o código e já deixo a suíte de testes rodando.
                  </p>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    className="border-border/60 text-foreground/90 hover:bg-accent/50 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-[13px] font-medium transition-colors"
                    onClick={() => console.log('[agent] connect to IM')}
                  >
                    <Signal className="size-4" />
                    Connect to IM
                  </button>
                </div>
              </div>
            </div>
          </ScrollArea>

          <div className="shrink-0 px-6 pt-2 pb-4">
            <div className="mx-auto max-w-3xl">
              <ChatInput />
            </div>
          </div>
        </div>

        {progressOpen && <ProgressPanel />}
      </div>
    </div>
  )
}
