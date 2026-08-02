import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Project } from '@/lib/projects/store'
import { cn } from '@/lib/utils'

export function TerminalSessionView({
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
            terminal.writeln(
              `\x1b[31mUnable to start terminal: ${result.error}\x1b[0m`,
            )
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
        'absolute inset-0 bg-[#0c0f14] px-2 py-1.5',
        active ? 'block' : 'invisible',
      )}
      data-terminal-instance={instanceKey}
    />
  )
}
