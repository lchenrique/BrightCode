import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ThreadState } from '../../electron/shared/agent-protocol'
import type { AgentRuntimeImageInput } from '../../electron/shared/agent-runtime-ipc'

function runtimeThreadId(taskId: string): string {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 110)
  return `runtime_${safeTaskId}`
}

export function useAgentThread(
  taskId: string,
  selection?: { modelId?: string; accountId?: string },
) {
  const threadId = useMemo(() => runtimeThreadId(taskId), [taskId])
  const [state, setState] = useState<ThreadState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const stateRef = useRef<ThreadState | null>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const api = window.electronAPI?.agentRuntime
    if (!api) {
      setError('O Agent Runtime V2 só está disponível no app desktop.')
      setLoading(false)
      return
    }

    let disposed = false
    let unsubscribe: (() => void) | undefined

    const connect = async () => {
      try {
        await api.createThread({ threadId })
        const initialState = await api.readThread({ threadId })
        if (disposed) return
        stateRef.current = initialState
        setState(initialState)

        const disconnect = await api.subscribe(
          {
            threadId,
            subscriptionId: `view_${crypto.randomUUID().replaceAll('-', '_')}`,
            afterSequence: initialState.sequence,
          },
          ({ state: nextState }) => {
            if (disposed) return
            setState((current) => {
              if (current && nextState.sequence < current.sequence) return current
              stateRef.current = nextState
              return nextState
            })
          },
        )
        if (disposed) {
          disconnect()
          return
        }
        unsubscribe = disconnect
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed) setLoading(false)
      }
    }

    void connect()
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [threadId])

  const send = useCallback(async (text: string, images?: AgentRuntimeImageInput[]) => {
    const api = window.electronAPI?.agentRuntime
    if (!api) throw new Error('Agent Runtime V2 indisponível.')
    setError(null)
    try {
      await api.startTurn({
        threadId,
        text,
        modelId: selection?.modelId,
        accountId: selection?.accountId,
        images,
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw cause
    }
  }, [selection?.accountId, selection?.modelId, threadId])

  const interrupt = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api) return
    setError(null)
    try {
      await api.interruptTurn({ threadId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [threadId])

  return {
    threadId,
    state,
    loading,
    error,
    send,
    interrupt,
    active: Boolean(state?.activeTurnId),
  }
}
