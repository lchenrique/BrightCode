/**
 * AgentAvatar — deterministic SVG avatar (DiceBear bottts style).
 *
 * The seed is just a string (agent name, id, or any stable token). Same
 * seed always renders the same robot, so avatars are reproducible
 * without storing image data.
 *
 * The component pre-computes the SVG once per seed+size combo and
 * memoizes the result. The bottle-neck in real usage is React's
 * re-render cost, not the DiceBear generator (≈2.6KB of SVG).
 *
 * For bots, projects, and any other "thing that needs a face" — this is
 * the default. Use a real Lucide icon for sidebar nav / status only.
 */

import { useMemo } from 'react'
import { createAvatar } from '@dicebear/core'
import { bottts } from '@dicebear/collection'
import { cn } from '@/lib/utils'

const PALETTE = [
  'transparent',
  'amber',
  'blue',
  'blueGrey',
  'brown',
  'cyan',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'purple',
  'red',
  'teal',
  'yellow',
]

/**
 * Twelve fixed seeds the picker cycles through when the user wants a
 * different face. They produce visually distinct robots in the bottts
 * style, so the user always sees a meaningful choice.
 */
export const AVATAR_PICKER_SEEDS = [
  'agent-azure',
  'agent-coral',
  'agent-drift',
  'agent-echo',
  'agent-flux',
  'agent-glade',
  'agent-helix',
  'agent-iris',
  'agent-jolt',
  'agent-kelp',
  'agent-lumen',
  'agent-mist',
] as const

export function avatarSvg(seed: string, _size = 64): string {
  return createAvatar(bottts, {
    seed,
    backgroundType: ['solid'],
    backgroundColor: [PALETTE[Math.abs(hash(seed)) % PALETTE.length]],
    radius: 50,
    scale: 92,
  }).toString()
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return h
}

export function AgentAvatar({
  seed,
  size = 32,
  className,
  rounded = true,
  imageSrc,
}: {
  seed: string
  size?: number
  className?: string
  rounded?: boolean
  imageSrc?: string
}) {
  const svg = useMemo(() => avatarSvg(seed, size), [seed, size])
  if (imageSrc) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center justify-center overflow-hidden bg-secondary/40 ring-1 ring-border/40',
          rounded && 'rounded-md',
          className,
        )}
        style={{ width: size, height: size }}
        data-avatar-kind="image"
        data-avatar-seed={seed}
        aria-hidden
      >
        <img
          src={imageSrc}
          alt=""
          width={size}
          height={size}
          className="size-full object-contain"
          draggable={false}
        />
      </span>
    )
  }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden bg-secondary/40 ring-1 ring-border/40',
        rounded && 'rounded-md',
        className,
      )}
      style={{ width: size, height: size }}
      data-avatar-kind="dicebear"
      data-avatar-seed={seed}
      aria-hidden
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
