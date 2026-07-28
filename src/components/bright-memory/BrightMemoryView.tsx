import {
  BrainCircuit,
  Check,
  CheckCircle2,
  Download,
  FileCheck2,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
  X,
} from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { useBrightMemory } from '@/hooks/use-bright-memory'

export function BrightMemoryView() {
  const { status, loading, installing, error, refresh, install } = useBrightMemory()

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bright-memory-view">
      <header className="border-border/60 flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <SidebarTrigger className="text-muted-foreground hover:text-foreground size-8" />
        <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg">
          <BrainCircuit className="size-4" />
        </div>
        <div className="min-w-0">
          <h1 className="text-[14px] font-semibold">Bright Memory</h1>
          <p className="text-muted-foreground text-[11px]">
            Persistent project context across agents and sessions
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground ml-auto"
          onClick={() => void refresh()}
          disabled={loading || installing}
          title="Check setup again"
        >
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <section
            className={
              status.ready
                ? 'border-emerald-500/30 bg-emerald-500/5 rounded-xl border p-5'
                : 'border-border/60 bg-card/30 rounded-xl border p-5'
            }
          >
            <div className="flex items-start gap-4">
              <div
                className={
                  status.ready
                    ? 'bg-emerald-500/10 text-emerald-500 flex size-11 shrink-0 items-center justify-center rounded-full'
                    : 'bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full'
                }
              >
                {loading ? (
                  <LoaderCircle className="size-5 animate-spin" />
                ) : status.ready ? (
                  <CheckCircle2 className="size-5" />
                ) : (
                  <BrainCircuit className="size-5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">
                  {loading
                    ? 'Checking Bright Memory...'
                    : status.ready
                      ? 'Bright Memory is ready'
                      : 'Complete Bright Memory setup'}
                </h2>
                <p className="text-muted-foreground mt-1 text-[12px] leading-relaxed">
                  {status.ready
                    ? 'BrightCode can recover context before work and save durable decisions afterward.'
                    : 'Install the CLI and global agent rule with one action.'}
                </p>
              </div>
            </div>

            <div className="border-border/50 mt-5 divide-y rounded-lg border">
              <SetupRow
                icon={TerminalSquare}
                label="Bright Memory CLI"
                detail={status.cliInstalled
                  ? `Installed${status.cliVersion ? ` · v${status.cliVersion}` : ''}`
                  : 'Not detected on PATH'}
                complete={status.cliInstalled}
              />
              <SetupRow
                icon={FileCheck2}
                label="Global agent rule"
                detail={status.globalRuleConfigured
                  ? status.rulePaths[0] ?? 'Configured'
                  : 'Managed global Markdown not found'}
                complete={status.globalRuleConfigured}
              />
            </div>

            {!loading && !status.ready && (
              <Button
                className="mt-5 w-full sm:w-auto"
                onClick={() => void install()}
                disabled={installing || !window.electronAPI}
                data-testid="bright-memory-install"
              >
                {installing ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
                {installing ? 'Installing Bright Memory...' : 'Install Bright Memory'}
              </Button>
            )}

            {error && (
              <p className="text-destructive mt-4 text-[11px] leading-relaxed" role="alert">
                {error}
              </p>
            )}
          </section>

          <section className="border-border/60 bg-card/20 rounded-xl border p-5">
            <h2 className="text-[13px] font-semibold">What the installer does</h2>
            <div className="text-muted-foreground mt-3 grid gap-3 text-[12px]">
              <Step number="1" text="Downloads and builds the official Bright Memory CLI." />
              <Step number="2" text="Installs the CLI globally with npm." />
              <Step number="3" text="Runs bright-memory setup and verifies the managed global Markdown." />
            </div>
            <p className="text-muted-foreground border-border/50 mt-4 border-t pt-4 text-[11px] leading-relaxed">
              Project identities remain local to each repository. BrightCode runs
              <code className="text-foreground mx-1 font-mono">bright-memory ensure</code>
              so a valid workspace is initialized only when needed.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

function SetupRow({
  icon: Icon,
  label,
  detail,
  complete,
}: {
  icon: typeof TerminalSquare
  label: string
  detail: string
  complete: boolean
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <Icon className="text-muted-foreground size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium">{label}</p>
        <p className="text-muted-foreground truncate text-[10.5px]" title={detail}>
          {detail}
        </p>
      </div>
      <span
        className={
          complete
            ? 'bg-emerald-500/10 text-emerald-500 flex size-6 items-center justify-center rounded-full'
            : 'bg-destructive/10 text-destructive flex size-6 items-center justify-center rounded-full'
        }
      >
        {complete ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      </span>
    </div>
  )
}

function Step({ number, text }: { number: string; text: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="bg-secondary text-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium">
        {number}
      </span>
      <span>{text}</span>
    </div>
  )
}
