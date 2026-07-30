import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Send, Square } from 'lucide-react'
import type { ThreadItem } from '../../../electron/shared/agent-protocol'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { Loader } from '@/components/ui/loader'
import { useAgentThread } from '@/hooks/use-agent-thread'
import { useTask } from '@/hooks/use-tasks'
import { cn } from '@/lib/utils'

interface InitialMessage {
  text: string
  images: Array<{ data: string; mediaType: string }>
}

export function AgentRuntimeTranscript({
  taskId,
  initialMessage,
}: {
  taskId: string
  initialMessage: InitialMessage | null
}) {
  const task = useTask(taskId)
  const { state, loading, error, send, interrupt, active } = useAgentThread(taskId, {
    modelId: task?.selectedModel,
    accountId: task?.selectedAccountId,
  })
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const sentInitialRef = useRef(false)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (
      sentInitialRef.current ||
      !initialMessage ||
      !state ||
      state.itemOrder.length > 0 ||
      active
    ) return
    sentInitialRef.current = true
    void send(initialMessage.text, initialMessage.images).catch(() => undefined)
  }, [active, initialMessage, send, state])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [state?.sequence])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (!value || active || submitting) return
    setSubmitting(true)
    try {
      await send(value)
      setText('')
    } catch {
      // The hook exposes the error in the transcript.
    } finally {
      setSubmitting(false)
    }
  }

  const items = state?.itemOrder
    .map((itemId) => state.items[itemId])
    .filter((item): item is ThreadItem => Boolean(item)) ?? []
  const latestTurn = state?.turnOrder.length
    ? state.turns[state.turnOrder[state.turnOrder.length - 1]]
    : undefined
  const runtimeStatus = active ? 'running' : (latestTurn?.status ?? 'idle')
  const statusLabel = runtimeStatus === 'running'
    ? 'executando'
    : runtimeStatus === 'interrupted'
      ? 'interrompido'
      : runtimeStatus === 'failed'
        ? 'falhou'
        : 'ocioso'

  return (
    <section
      className="bg-background flex h-full min-h-0 flex-col"
      data-agent-runtime-v2="true"
      data-thread-id={state?.threadId}
      data-sequence={state?.sequence ?? 0}
    >
      <header className="border-border/60 flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <span className="text-foreground text-[12px] font-medium">Agent Runtime V2</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            runtimeStatus === 'running'
              ? 'bg-primary/15 text-primary'
              : runtimeStatus === 'failed' || runtimeStatus === 'interrupted'
                ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground',
          )}
          data-runtime-status={runtimeStatus}
        >
          {statusLabel}
        </span>
        <span className="text-muted-foreground ml-auto font-mono text-[10px]">
          seq {state?.sequence ?? 0}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-testid="runtime-transcript">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {loading && (
            <div className="text-muted-foreground flex items-center gap-2 py-8 text-[12px]">
              <Loader size={16} label="Abrindo thread" />
              Abrindo thread persistida
            </div>
          )}

          {!loading && items.length === 0 && (
            <div className="border-border/60 bg-card/30 rounded-lg border px-4 py-5">
              <p className="text-foreground text-[13px] font-medium">Thread persistida pronta</p>
              <p className="text-muted-foreground mt-1 text-[12px]">
                Este fluxo usa o runtime no processo principal e um provider local determinístico.
              </p>
            </div>
          )}

          {items.map((item) => <RuntimeItemView key={item.itemId} item={item} />)}

          {error && (
            <div
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-[12px]"
              role="alert"
            >
              {error}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      <form className="border-border/60 shrink-0 border-t p-3" onSubmit={submit}>
        <div className="border-border bg-card mx-auto flex max-w-3xl items-end gap-2 rounded-lg border p-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="Envie uma mensagem ao Runtime V2"
            aria-label="Mensagem para o Agent Runtime V2"
            className="text-foreground placeholder:text-muted-foreground max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[13px] outline-none"
            rows={1}
            disabled={active}
          />
          {active ? (
            <button
              type="button"
              className="bg-destructive/10 text-destructive hover:bg-destructive/20 inline-flex size-9 items-center justify-center rounded-md"
              aria-label="Interromper turno"
              onClick={() => void interrupt()}
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex size-9 items-center justify-center rounded-md disabled:opacity-40"
              aria-label="Enviar mensagem"
              disabled={!text.trim() || submitting || loading}
            >
              {submitting ? <Loader size={15} label="Enviando" /> : <Send className="size-4" />}
            </button>
          )}
        </div>
      </form>
    </section>
  )
}

function RuntimeItemView({ item }: { item: ThreadItem }) {
  if (item.kind === 'user-message') {
    return (
      <article className="flex justify-end" data-runtime-item="user-message">
        <div className="bg-secondary/70 max-w-[85%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed">
          {item.imageRefs?.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {item.imageRefs.map((src) => (
                <img key={src.slice(-40)} src={src} alt="Anexo" className="size-20 rounded-md object-cover" />
              ))}
            </div>
          ) : null}
          {item.text}
        </div>
      </article>
    )
  }

  if (item.kind === 'agent-message') {
    return (
      <article
        className="text-foreground ml-1 text-[13px] leading-relaxed"
        data-runtime-item="agent-message"
        data-item-status={item.status}
      >
        {item.text ? <MarkdownRenderer content={item.text} /> : <Loader size={14} label="Gerando resposta" />}
      </article>
    )
  }

  if (item.kind === 'reasoning') {
    return (
      <details
        className="border-border/60 bg-card/30 rounded-md border px-3 py-2"
        open={item.status === 'in_progress'}
        data-runtime-item="reasoning"
      >
        <summary className="text-muted-foreground cursor-pointer text-[11px] font-medium">
          Raciocínio {item.status === 'in_progress' ? 'em andamento' : 'concluído'}
        </summary>
        <p className="text-muted-foreground mt-2 whitespace-pre-wrap text-[11px] leading-relaxed">{item.text}</p>
      </details>
    )
  }

  const title = runtimeItemTitle(item)
  return (
    <article
      className="border-border/60 bg-card/30 rounded-md border px-3 py-2"
      data-runtime-item={item.kind}
      data-item-status={item.status}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-foreground font-medium">{title}</span>
        <span className="text-muted-foreground ml-auto">{item.status}</span>
      </div>
      {'message' in item && item.message ? (
        <p className="text-destructive mt-1 text-[11px]">{item.message}</p>
      ) : null}
      {'command' in item && item.command ? (
        <code className="text-muted-foreground mt-1 block text-[11px]">{item.command}</code>
      ) : null}
    </article>
  )
}

function runtimeItemTitle(item: ThreadItem): string {
  switch (item.kind) {
    case 'tool-call': return item.name || 'Ferramenta'
    case 'command-execution': return 'Comando'
    case 'file-change': return `Arquivo: ${item.path}`
    case 'skill-use': return `Skill: ${item.skillName}`
    case 'mcp-tool-call': return `MCP: ${item.toolName}`
    case 'plan': return 'Plano'
    case 'todo': return 'Tarefas'
    case 'question': return 'Pergunta'
    case 'subagent': return `Subagente: ${item.label}`
    case 'compaction': return 'Compactação'
    case 'error': return 'Erro'
    default: return item.kind
  }
}
