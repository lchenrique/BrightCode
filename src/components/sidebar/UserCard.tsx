import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Settings } from 'lucide-react'

export function UserCard({
  name,
  plan,
  initials,
  avatarUrl,
  onClick,
}: {
  name: string
  plan: string
  initials: string
  avatarUrl?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-sidebar-accent/60 group/user flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors cursor-pointer"
    >
      <Avatar className="ring-1 ring-border/50 size-8 shrink-0">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={name} />}
        <AvatarFallback className="bg-primary/25 text-primary text-[11px] font-bold">
          {initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-[13px] font-medium text-foreground">
          {name}
        </div>
        <div className="text-muted-foreground truncate text-[11px]">{plan}</div>
      </div>
      <Settings className="text-muted-foreground group-hover/user:text-foreground size-4 shrink-0 transition-colors" />
    </button>
  )
}
