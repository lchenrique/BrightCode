import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

type Item = {
  title: string
  icon: LucideIcon
  accent?: boolean
}

export function SidebarTopNav({
  items,
  onItemClick,
}: {
  items: readonly Item[]
  onItemClick?: (title: string) => void
}) {
  return (
    <SidebarMenu className="gap-0.5">
      {items.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton
            size="default"
            onClick={() => onItemClick?.(item.title)}
            className={cn(
              'text-foreground/80 data-[active=true]:bg-transparent',
              item.accent &&
                'bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground rounded-lg font-medium',
            )}
          >
            <item.icon
              className={
                item.accent
                  ? 'text-sidebar-primary-foreground size-4'
                  : 'text-muted-foreground size-4'
              }
            />
            <span className="text-[13px]">{item.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}
