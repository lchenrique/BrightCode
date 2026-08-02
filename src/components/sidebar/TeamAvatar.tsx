import { AgentAvatar } from '@/components/ui/agent-avatar'

type Color = 'rose' | 'amber' | 'primary' | 'emerald' | 'neutral'

const colorRing: Record<Color, string> = {
  rose: 'ring-rose-500/40',
  amber: 'ring-amber-500/40',
  primary: 'ring-primary/40',
  emerald: 'ring-emerald-500/40',
  neutral: 'ring-zinc-500/40',
}

export function TeamAvatar({
  seed,
  color,
  size = 'sm',
  imageSrc,
}: {
  seed: string
  color: Color
  size?: 'xs' | 'sm' | 'md'
  /** Override the DiceBear avatar with a local image (e.g. the
   *  bright-code mascot in `/agent-avatar.png`). */
  imageSrc?: string
}) {
  const px = size === 'xs' ? 20 : size === 'sm' ? 24 : 32
  return (
    <AgentAvatar
      seed={seed}
      size={px}
      className={`ring-1 ${colorRing[color]}`}
      imageSrc={imageSrc}
    />
  )
}
