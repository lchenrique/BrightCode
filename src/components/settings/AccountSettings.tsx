import {
  CircleUser,
  Crown,
  KeyRound,
  LogIn,
  Monitor,
  Smartphone,
  Star,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useRegisteredProviders } from '@/hooks/use-provider-registry'
import { accountStore } from '@/lib/providers/auth/account-store'
import type { ProviderAccount } from '@/lib/providers'

function SectionLabel({ children }: { children: string }) {
  return (
    <span className="text-muted-foreground/70 text-[11px] font-normal tracking-wide uppercase">
      {children}
    </span>
  )
}

export function AccountSettings() {
  const allRegistered = useRegisteredProviders()
  const allProviders = allRegistered.map((r) => r.provider)
  // Pull accounts straight from the in-memory store. The Account tab is
  // opened infrequently so re-reading on each render is fine.
  const accountsByProvider: Record<string, ProviderAccount[]> = {}
  let totalAccounts = 0
  for (const p of allProviders) {
    const list = accountStore.listAccounts(p.id)
    accountsByProvider[p.id] = list
    totalAccounts += list.length
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Profile card */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Profile</SectionLabel>
        <div className="flex items-center gap-3 rounded-xl border border-border/60 p-4">
          <div className="bg-amber-500/15 flex size-12 items-center justify-center rounded-full text-amber-500">
            <CircleUser className="size-7" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">Carlos Henrique</div>
            <div className="text-muted-foreground text-[12px]">
              lc.henriquee@gmail.com
            </div>
            <div className="mt-1 flex items-center gap-1.5">
              <Crown className="size-3 text-amber-500" />
              <span className="text-[11.5px] font-medium text-amber-500">Plus Plan</span>
            </div>
          </div>
          <Button variant="outline" size="sm" className="text-[12px]">
            Manage plan
          </Button>
        </div>
      </section>

      {/* Stats */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Workspace</SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          <StatCard
            label="Providers"
            value={allProviders.length}
            icon={<KeyRound className="size-3.5" />}
          />
          <StatCard
            label="Accounts"
            value={totalAccounts}
            icon={<LogIn className="size-3.5" />}
          />
          <StatCard
            label="Active devices"
            value={1}
            icon={<Monitor className="size-3.5" />}
          />
        </div>
      </section>

      <Separator />

      {/* Devices */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Connected devices</SectionLabel>
        <div className="flex flex-col gap-2">
          <DeviceRow
            icon={<Monitor className="size-4" />}
            name="This machine"
            meta="BrightCode 0.1.0 — Electron 33 · Windows 11"
            current
          />
          <DeviceRow
            icon={<Smartphone className="size-4" />}
            name="No mobile devices paired"
            meta="Scan a QR code from the Connect Mobile tab to add one"
            disabled
          />
        </div>
      </section>

      <Separator />

      {/* Provider list */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Provider accounts</SectionLabel>
        <div className="flex flex-col gap-2">
          {allProviders.map((p) => {
            const list = accountsByProvider[p.id] ?? []
            const enabled = list.filter((a) => a.enabled).length
            return (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-[12.5px] font-medium">{p.name}</div>
                  <div className="text-muted-foreground text-[11.5px]">
                    {list.length === 0
                      ? 'No accounts'
                      : `${enabled} enabled · ${list.length} total`}
                  </div>
                </div>
                <span className="text-muted-foreground/70 text-[10.5px] tracking-wide uppercase">
                  {p.id}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      <Separator />

      {/* About / sign out */}
      <section className="flex flex-col gap-3">
        <SectionLabel>Session</SectionLabel>
        <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
          <div>
            <div className="text-[12.5px] font-medium">Sign out</div>
            <div className="text-muted-foreground text-[11.5px]">
              Clear all stored credentials. You'll have to sign in again to chat.
            </div>
          </div>
          <Button variant="destructive" size="sm" className="text-[12px]">
            Sign out
          </Button>
        </div>
      </section>

      {/* Easter egg */}
      <div className="text-muted-foreground/60 mt-2 flex items-center gap-1 text-[10.5px]">
        <Star className="size-3" />
        <span>BrightCode is open-source. Thanks for using it.</span>
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  icon,
}: {
  label: string
  value: number
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border/60 px-3 py-2.5">
      <div className="text-muted-foreground flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide uppercase">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function DeviceRow({
  icon,
  name,
  meta,
  current,
  disabled,
}: {
  icon: React.ReactNode
  name: string
  meta: string
  current?: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2">
      <div className="text-muted-foreground flex size-8 items-center justify-center rounded-md bg-accent/40">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-[12.5px] font-medium ${
            disabled ? 'text-muted-foreground' : ''
          }`}
        >
          {name}
        </div>
        <div className="text-muted-foreground truncate text-[11.5px]">{meta}</div>
      </div>
      {current && (
        <span className="text-emerald-500 bg-emerald-500/10 inline-flex h-5 items-center rounded-full px-2 text-[10.5px] font-medium">
          Current
        </span>
      )}
    </div>
  )
}
