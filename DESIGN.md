# BrightCode Design System

Conventions for the Electron + React app. Read this before adding a component,
overlay, or style. The rule of thumb: **one source per concern, tokens over
literals, flat over boxed.** If you reach for a raw color, a one-off shadow, a
bespoke button, or a hardcoded `px-*` on a control — stop, there's already a
primitive for it.

This file owns the visual and interaction contract. Read [`AGENTS.md`](./AGENTS.md)
for architecture, state, resolver, transport, and testing rules.

This doc contains two kinds of content, maintained differently:

- **Principles** (flatness, intent, feedback, motion, cancellation) are durable.
  They hold as components come and go.
- **Named contracts** (tokens, `Button` variants, primitive names) are the
  design system's current API. They are maintained *with* the code: if you
  change a primitive, token, or variant, update its entry here **in the same
  change** — a stale name in this file is a bug, exactly like a stale type.

When a rule and the code disagree, fix whichever is wrong rather than forking a
one-off at the call site.

**Upstream reference:** NousResearch's [hermes-agent desktop
DESIGN.md](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/DESIGN.md).
We mirror their principles; their tokens are adjusted to ours.

## Principles

1. **Flat, not boxed.** No card-in-card, no divider borders inside a panel.
   Group with whitespace and a single hairline, never nested rounded boxes.
2. **Borderless elevation for floating panels.** Overlays float on
   `shadow-nous` + a `--stroke-nous` hairline, not thick framed boxes. In-panel
   structure may use token hairlines sparingly.
3. **One primitive per concern.** One `Button`, one set of control variants,
   one `Loader`, one `ErrorState`. Migrate onto them; don't fork.
4. **Tokens, not literals.** Reference CSS vars (`--ui-*`, `--shadow-nous`,
   `--stroke-nous`, `--theme-*`), never raw hex / ad-hoc rgba in components.
5. **Style lives in the primitive.** Variants and sizes own padding, radius,
   color, chrome. Call sites pass a `variant`/`size`, not `className` overrides
   that re-specify those.
6. **Intent before automation.** Surface useful actions and previews, but do not
   open panes, move focus, or navigate because a tool happened to produce
   something.
7. **Immediate feedback.** Direct manipulation updates the view first. Network
   or disk persistence reconciles afterward and rolls back visibly on failure.

## Stroke & color tokens

Defined in `src/index.css` (Hermes-style layer derived from the base theme
tokens, so they adapt across all themes — politron, catppuccin, supabase, …).

| Token | Use |
| --- | --- |
| `--ui-stroke-primary` | strongest hairline |
| `--ui-stroke-secondary` | secondary hairline |
| `--ui-stroke-tertiary` | default in-panel divider / list hairline |
| `--ui-stroke-quaternary` | lightest hairline (subtle group) |
| `--stroke-nous` | overlay hairline (pairs with `shadow-nous`) |
| `--ui-text-primary / -secondary / -tertiary` | text hierarchy |
| `--ui-bg-quaternary` | soft control fill |
| `--chrome-action-hover` | hover fill for quiet controls |
| `--shadow-nous` | floating-panel elevation |

Never hardcode `border-gray-*`, `bg-white`, `text-black`, etc. in components.

## Buttons — one component

`src/components/ui/button.tsx` is the single source. Pick a `variant` + `size`;
do **not** pass `h-*`, `px-*`, `py-*`, or icon-size overrides.

**Variants:**
- `default` — primary
- `destructive`
- `secondary` — soft fill (the default non-primary look)
- `outline` — transparent + 1px ring, no fill/shadow
- `ghost`
- `link`
- `text` — boxless quiet inline ("Cancel", "Clear")
- `textStrong` — bold underlined inline affordance ("Change", "Open logs")

**Sizes:**
- `default` (h-9), `sm` (h-8), `lg` (h-10), `xs` (h-7) — boxed buttons
- `inline` — flush, zero box, for buttons inside a heading/sentence
- `micro` (h-5) — status-stack / table-footers
- `icon` / `icon-xs` / `icon-sm` / `icon-lg` / `icon-titlebar` — icon family

Notes:
- Text buttons (`text`, `textStrong`) are square (no radius) and sized by
  padding + line-height (no fixed heights).
- SVGs inherit `size-4` (`size-3.5` at `xs`/`sm`). Don't re-set icon size.
- Polymorph with `asChild` when the button must render as a link/Slot.

## Tooltips — `<Tip>`

`src/components/ui/tip.tsx` wraps Radix Tooltip in a single ergonomic call.
**Never use native `title=` on buttons** — unstyled, ~500ms OS delay, clashes
with the themed `Tip`.

```tsx
<Tip label="New task for this project" kbd="Ctrl+N">
  <Button variant="ghost" size="icon" aria-label="New task">+</Button>
</Tip>
```

**Tip unlabeled chrome that needs discovery** — toolbar / titlebar / statusbar
icons, keybind shortcuts, ownership chips, truncated paths, hostnames.

**Do not tip:**
- Menu triggers (kebabs / ⋯) — the affordance is "open menu"; verbs live there
- Close / dismiss X buttons — the glyph is the label (`aria-label` only)
- Controls whose visible label already says what the tip would

## Feedback & empty/error/loading states

- **Loading:** `<Loader variant="spin">` (lemniscate-bloom for long ops).
  Other variants: `dots`, `bars`, `ring`. Never ship the literal text "Loading…".
- **Errors:** `<ErrorState>` + the canonical `ErrorIcon` (no bg chip). One look
  for the React boundary, in-dialog errors, and the boot-failure banner. Pass
  nodes for title/description so Radix `DialogTitle`/`Description` can flow
  through for a11y.
- **Empty:** TBD — add `<EmptyState>` primitive when needed.
- **Logs:** TBD — add `<LogView>` primitive when needed.

## Surfaces & elevation

Floating panels (base `Dialog`, route overlays, boot/install/update surfaces,
model-picker, onboarding, prompt overlays, notifications) use:

```
shadow-nous           /* downward-weighted, layered contact→ambient falloff */
border-(--stroke-nous) /* currentColor hairline, theme-adaptive */
```

Both are CSS vars in `src/index.css` — tune in one place, everything inherits.
Don't add per-overlay `shadow-[…]` or `border-(--ui-stroke-secondary)`
one-offs; if elevation needs to change, change the token.

## Motion

- Quick, functional transitions (~100ms on controls). Respect
  `prefers-reduced-motion` for anything beyond a fade.
- Motion follows state; it never delays state. Selection, drag targets, cancel,
  and pressed feedback paint in the current frame.
- Do not animate layout geometry with `transition-all` on a hot interaction.
  Name the properties, avoid backdrop-filter repaints during movement, and
  remove animation before masking a performance problem.

## Affordances

- `cursor-pointer` at the primitive level (Button, dropdown/select) — don't
  hardcode it per call site.
- Global focus-ring reset.
- `Esc` closes every dismissable overlay/dialog (install/onboarding excluded);
  close is an x-icon, not the word "Close".

## Before you add something — checklist

- [ ] Reuse a primitive (`Button`, `Tip`, `Loader`, `ErrorState`) instead of forking one?
- [ ] Tokens (`--ui-*`, `--shadow-nous`, `--stroke-nous`) — zero raw colors / one-off shadows?
- [ ] No `className` overriding a primitive's padding / size / radius / chrome?
- [ ] Tips only where hover teaches something new (no kebab / menu-trigger tips; no native `title=`)?
- [ ] Flat — no card-in-card, no gratuitous row dividers?
- [ ] No automatic navigation, focus steal, or pane opening from background events?
- [ ] Direct manipulation paints immediately and rolls back cleanly on failure?
- [ ] Hot interactions avoid broad subscriptions, layout thrash, and `transition-all`?
- [ ] Touched a primitive, token, or variant? Its named-contract entry in this file is updated in the same change.
