/**
 * Subtle grid background — visible edge to edge with only a whisper
 * of fade at the far edges, so the texture reads across the whole
 * canvas like MiniMax Code's main area. Pure CSS, no SVG needed.
 */
export function GridBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      style={{
        backgroundImage:
          'linear-gradient(to right, oklch(from var(--foreground) l c h / 5%) 1px, transparent 1px), ' +
          'linear-gradient(to bottom, oklch(from var(--foreground) l c h / 5%) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
        maskImage:
          'radial-gradient(ellipse at center, black 60%, transparent 100%)',
        WebkitMaskImage:
          'radial-gradient(ellipse at center, black 60%, transparent 100%)',
      }}
    />
  )
}
