import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  PanelBottomClose,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

const TERMINAL_MIN_HEIGHT = 140
const TERMINAL_DEFAULT_HEIGHT = 260

type TerminalTab = {
  key: string
  label: string
}

export function TerminalPanel({
  project,
  height,
  onHeightChange,
  onRequestClose,
}: {
  project: Project
  height: number
  onHeightChange: (height: number) => void
  onRequestClose: () => void
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => [createTerminalTab(1)])
  const [activeKey, setActiveKey] = useState(() => tabs[0]!.key)

  const addTerminal = () => {
    const next = createTerminalTab(tabs.length + 1)
    setTabs((current) => [...current, next])
    setActiveKey(next.key)
  }

  const handleShellReady = useCallback((key: string, shell: string) => {
    setTabs((current) =>
      current.map((item) =>
        item.key === key ? { ...item, label: shell } : item,
      ),
    )
  }, [])

  const closeTerminal = (key: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.key === key)
      const next = current.filter((tab) => tab.key !== key)
      if (next.length === 0) {
        onRequestClose()
        const replacement = createTerminalTab(1)
        setActiveKey(replacement.key)
        return [replacement]
      }
      if (activeKey === key) {
        setActiveKey(next[Math.min(index, next.length - 1)]!.key)
      }
      return next
    })
  }

  return (
    <section
      className="border-border/70 bg-[#0c0f14] relative flex shrink-0 flex-col border-t"
      style={{ height }}
      aria-label="Terminal panel"
      data-terminal-panel
    >
      <TerminalPanelResizeHandle
        height={height}
        onResize={onHeightChange}
      />

      <div className="border-border/60 flex h-8 shrink-0 items-center border-b bg-[#11141a]">
        <div
          role="tablist"
          aria-label="Terminals"
          className="flex h-full min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const active = tab.key === activeKey
            return (
              <div
                key={tab.key}
                role="tab"
                aria-selected={active}
                className={cn(
                  'group relative flex h-full min-w-[118px] max-w-[180px] items-center gap-1.5 border-r px-2.5 text-[11px]',
                  active
                    ? 'bg-[#0c0f14] text-zinc-100'
                    : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300',
                )}
                onClick={() => setActiveKey(tab.key)}
              >
                {active && (
                  <span className="bg-primary absolute inset-x-0 top-0 h-0.5" />
                )}
                <SquareTerminal className="size-3.5 shrink-0" />
                <span className="truncate">{tab.label}</span>
                <button
                  type="button"
                  aria-label={`Close ${tab.label}`}
                  className="ml-auto inline-flex size-4 items-center justify-center rounded opacity-0 hover:bg-white/10 group-hover:opacity-100 focus:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTerminal(tab.key)
                  }}
                >
                  <X className="size-3" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 px-1">
          <button
            type="button"
            aria-label="New terminal"
            title="New terminal"
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
            onClick={addTerminal}
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Hide terminal panel"
            title="Hide terminal"
            className="inline-flex size-6 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
            onClick={onRequestClose}
          >
            <PanelBottomClose className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <TerminalSessionView
            key={tab.key}
            instanceKey={tab.key}
            project={project}
            active={tab.key === activeKey}
            onShellReady={handleShellReady}
          />
        ))}
      </div>
    </section>
  )
}

function TerminalSessionView({
  instanceKey,
  project,
  active,
  onShellReady,
}: {
  instanceKey: string
  project: Project
  active: boolean
  onShellReady: (key: string, shell: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    const api = window.electronAPI?.terminal
    if (!container || !api) return

    let disposed = false
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: true,
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: '#0c0f14',
        foreground: '#d4d4d8',
        cursor: '#f4f4f5',
        cursorAccent: '#0c0f14',
        selectionBackground: '#3f3f4688',
        black: '#18181b',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#facc15',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#71717a',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde047',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fitAddon

    const fit = () => {
      if (container.clientWidth < 1 || container.clientHeight < 1) return
      try {
        fitAddon.fit()
      } catch {
        // The terminal may be between mount and layout.
      }
    }

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)
    requestAnimationFrame(fit)

    const removeDataListener = api.onData((event) => {
      if (event.sessionId === sessionIdRef.current) terminal.write(event.data)
    })
    const removeExitListener = api.onExit((event) => {
      if (event.sessionId !== sessionIdRef.current) return
      terminal.writeln(
        `\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m`,
      )
      sessionIdRef.current = null
    })
    const inputDisposable = terminal.onData((data) => {
      const sessionId = sessionIdRef.current
      if (sessionId) api.write(sessionId, data)
    })
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      const sessionId = sessionIdRef.current
      if (sessionId) api.resize(sessionId, cols, rows)
    })

    void api
      .create(project.id, { cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (!result.ok) {
          if (!disposed) {
            terminal.writeln(`\x1b[31mUnable to start terminal: ${result.error}\x1b[0m`)
          }
          return
        }
        if (disposed) {
          void api.kill(result.sessionId)
          return
        }
        sessionIdRef.current = result.sessionId
        onShellReady(instanceKey, result.shell)
        fit()
        terminal.focus()
      })

    return () => {
      disposed = true
      const sessionId = sessionIdRef.current
      sessionIdRef.current = null
      if (sessionId) void api.kill(sessionId)
      inputDisposable.dispose()
      resizeDisposable.dispose()
      removeDataListener()
      removeExitListener()
      resizeObserver.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [instanceKey, onShellReady, project.id])

  useEffect(() => {
    if (!active) return
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        // Ignore a transient hidden layout.
      }
      terminalRef.current?.focus()
    })
  }, [active])

  if (!window.electronAPI?.terminal) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-zinc-500">
        Terminal is available in the desktop app.
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        'absolute inset-0 px-2 py-1.5',
        active ? 'block' : 'invisible',
      )}
      data-terminal-instance={instanceKey}
    />
  )
}

function TerminalPanelResizeHandle({
  height,
  onResize,
}: {
  height: number
  onResize: (height: number) => void
}) {
  const dragRef = useRef<{
    pointerId: number
    startY: number
    startHeight: number
    maxHeight: number
  } | null>(null)

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    document.documentElement.classList.remove('panel-resizing')
  }

  useEffect(
    () => () => document.documentElement.classList.remove('panel-resizing'),
    [],
  )

  return (
    <div
      role="separator"
      aria-label="Resize terminal panel"
      aria-orientation="horizontal"
      aria-valuemin={TERMINAL_MIN_HEIGHT}
      aria-valuenow={Math.round(height)}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="group/terminal-resize absolute inset-x-0 -top-2 z-40 h-4 cursor-row-resize touch-none"
      data-terminal-resize
      onPointerDown={(event) => {
        if (event.button !== 0) return
        const workspaceHeight =
          event.currentTarget.parentElement?.parentElement
            ?.getBoundingClientRect().height ?? window.innerHeight
        dragRef.current = {
          pointerId: event.pointerId,
          startY: event.clientY,
          startHeight: height,
          maxHeight: Math.max(TERMINAL_MIN_HEIGHT, workspaceHeight * 0.72),
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        document.documentElement.classList.add('panel-resizing')
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current
        if (!drag || drag.pointerId !== event.pointerId) return
        onResize(
          clampTerminalHeight(
            drag.startHeight + (drag.startY - event.clientY),
            drag.maxHeight,
          ),
        )
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onResize(TERMINAL_DEFAULT_HEIGHT)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        onResize(
          clampTerminalHeight(
            height + (event.key === 'ArrowUp' ? 16 : -16),
            window.innerHeight * 0.72,
          ),
        )
      }}
    >
      <div className="group-hover/terminal-resize:bg-primary/60 mt-[7px] h-0.5 w-full transition-colors" />
    </div>
  )
}

function clampTerminalHeight(height: number, maxHeight: number): number {
  return Math.min(maxHeight, Math.max(TERMINAL_MIN_HEIGHT, height))
}

function createTerminalTab(index: number): TerminalTab {
  return {
    key: crypto.randomUUID(),
    label: `Terminal ${index}`,
  }
}
