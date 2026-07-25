import { cn } from '@/lib/utils'

type Color = 'rose' | 'amber' | 'primary' | 'emerald' | 'neutral'

const colorMap: Record<Color, string> = {
  rose: 'bg-rose-500/25 text-rose-200 ring-rose-500/40',
  amber: 'bg-amber-500/25 text-amber-200 ring-amber-500/40',
  primary: 'bg-primary/25 text-primary ring-primary/40',
  emerald: 'bg-emerald-500/25 text-emerald-200 ring-emerald-500/40',
  neutral: 'bg-zinc-500/20 text-zinc-300 ring-zinc-500/40',
}

export function TeamAvatar({
  emoji,
  color,
  size = 'sm',
}: {
  emoji: string
  color: Color
  size?: 'xs' | 'sm' | 'md'
}) {
  const sizeClass =
    size === 'xs'
      ? 'size-5 text-[11px]'
      : size === 'sm'
        ? 'size-6 text-[14px]'
        : 'size-8 text-base'

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium ring-1',
        colorMap[color],
        sizeClass,
      )}
      aria-hidden
    >
      {emoji}
    </span>
  )
}
