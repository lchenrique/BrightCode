/**
 * Subtle grid background — visible edge to edge with only a whisper
 * of fade at the far edges, so the texture reads across the whole
 * canvas like MiniMax Code's main area. Pure CSS, no SVG needed.
 *
 * Two layers: the fine 40px grid, plus wide vertical bands at very
 * low opacity that give the canvas a faint architectural rhythm.
 */
export function GridBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0"
      style={{
        backgroundImage:
          'repeating-linear-gradient(to right, oklch(from var(--foreground) l c h / 3.5%) 0px, oklch(from var(--foreground) l c h / 3.5%) 120px, transparent 120px, transparent 240px), ' +
          'linear-gradient(to right, oklch(from var(--foreground) l c h / 8%) 1px, transparent 1px), ' +
          'linear-gradient(to bottom, oklch(from var(--foreground) l c h / 8%) 1px, transparent 1px)',
        backgroundSize: '240px 100%, 40px 40px, 40px 40px',
        maskImage:
          'radial-gradient(ellipse at center, black 60%, transparent 100%)',
        WebkitMaskImage:
          'radial-gradient(ellipse at center, black 60%, transparent 100%)',
      }}
    />
  )
}
