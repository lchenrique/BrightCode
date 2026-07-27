# BrightCode — Agent Guidelines

This file is the single source of truth for how AI agents (and humans)
contribute to the BrightCode codebase. Keep it short, opinionated, and
in sync with the code.

## No emoji in the UI

The BrightCode UI is **emoji-free**. The previous design used emoji
glyphs (🎨, 🏛️, 🔎, …) for agent personas and for the icon picker,
and the result looked childish and inconsistent with the rest of the
IDE. We replaced it with **DiceBear bottts avatars** — a deterministic
SVG generator that produces a distinct robot per seed.

### Rules

- **Never** add an emoji to a user-facing surface in `src/`. Use a
  Lucide icon for actions, navigation, status; use a DiceBear avatar
  for agents, projects, or any "thing that needs a face".
- **Agent identity** is stored as `avatarSeed: string` on
  `AgentDefinition` and `AgentPreset`. The seed is rendered by
  `<AgentAvatar seed={...} size={...} />` in `src/components/ui/agent-avatar.tsx`.
  Same seed = same robot, so the seed can be the agent `id` or `name`.
- **For system / navigation icons**, use `lucide-react` (already
  installed). Examples: `<Monitor />`, `<Terminal />`, `<Bot />`.
- **Comments** may contain emoji for clarity (e.g. diagram-style
  ASCII comments), but **strings rendered to the user must not**.
- **Commit messages, PR titles, and changelog** are written without
  emoji.

### How to pick a new agent face

1. In `CreateAgentDialog`, the user clicks the avatar button and picks
   from a 12-tile grid (`AVATAR_PICKER_SEEDS` in `agent-avatar.tsx`).
2. "Shuffle" button picks a random seed from the same pool.
3. The chosen seed is stored on the agent and re-rendered everywhere
   (sidebar, chat, settings).

### Migration

Older agents saved to `electron-store` had an `emoji: string` field.
`agentStore.migrate()` backfills `avatarSeed` from the old emoji (or
the agent name) on first read. The migration is one-way; the `emoji`
field is dropped from the type.

## Other house rules

- **caveman ultra mode** for chat output. Token-efficient, no
  filler, no customer-service tone.
- **Language**: Portuguese (BR) for user-facing copy in conversation;
  English for code identifiers and comments.
- **Surgical diffs**: don't refactor surrounding code. Match the
  comment density of the file you're editing.
- **Validate with CDP**: any UI change ships with a CDP test in
  `scripts/cdp-*.mjs` and screenshots in `scripts/screenshots/`.
