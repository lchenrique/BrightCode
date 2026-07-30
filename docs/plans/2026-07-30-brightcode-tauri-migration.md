# BrightCode — Electron → Tauri Migration (Hybrid Gradual)

**Date**: 2026-07-30
**Status**: Design approved, pending implementation plan
**Author**: brainstorm session (user + agent)

## Motivation

User-driven pivot from Electron to Tauri. Primary motivation is **performance**
(smaller binary, faster cold start, lower memory) plus a personal preference to
move off Chromium-embedded desktop apps. The current Electron build was hitting
CJS/ESM bundling issues with the new `@openai/agents` SDK, reinforcing the
frustration with the Electron toolchain.

The Agent Runtime V2 work landed on `master` four commits before this pivot and
is fresh (the OpenAI Agents SDK integration, CDP vertical slice, image support,
invalid-selection failure semantics). Discarding that work would waste
significant investment, so the migration strategy preserves it as a Node sidecar.

## Strategy: Hybrid Gradual

Tauri Rust shell owns windowing, IPC surface, security model, native plugins
(dialog, shell, store, credential, pty). A Node sidecar runs the existing Agent
Runtime V2 (`@openai/agents`, turn-scheduler, EventStore, providers) unchanged.
The two communicate over HTTP on localhost with an auth token. Future
incremental Rust migration of hot paths (notably EventStore) is possible
without rewriting the agent runtime wholesale.

## Decisions locked from brainstorm

| Decision | Choice | Reason |
|---|---|---|
| Backend strategy | Hybrid: Rust shell + Node sidecar | Preserves Runtime V2 (3000 lines, 248 tests) while delivering Tauri perf wins |
| Target platforms | Windows only | Simplifies build, signing, native deps |
| Renderer | React + Vite (unchanged) | No need to touch UI work |
| Runtime V2 | Node sidecar, no rewrite | `@openai/agents` is TS-first, reescrita Rust = semanas sem ganho real |
| Working tree | Discard uncommitted changes before scaffold | Electron artifacts (vite.config mods, merge fixes) are dead weight on Tauri branch |
| Rust toolchain | stable-x86_64-pc-windows-msvc (already installed) | Avoid GNU toolchain confusion |
| Auth between Tauri ↔ sidecar | HTTP localhost + short-lived token | Simplest secure boundary for local IPC |

## Architecture

```
┌─────────────────────────────────────────────┐
│ Tauri Rust shell (windowing, IPC, security) │
│                                             │
│  ┌─────────────┐         ┌────────────────┐ │
│  │ Rust cmds   │ ◄─HTTP─►│ Node sidecar   │ │
│  │ (whitelist) │   /WS   │ agent-runtime  │ │
│  └─────────────┘         └────────────────┘ │
│        ▲                                    │
│        │ invoke()                           │
└────────┼────────────────────────────────────┘
         │
┌────────┼────────────────────────────────────┐
│  Renderer (React + Vite, mesmo src/)       │
│  window.electronAPI.* → invoke('cmd', args)│
└─────────────────────────────────────────────┘
```

### Boundary rules (rigid)

1. Renderer talks **only** to Tauri commands (whitelist enforced by Tauri)
2. Tauri commands proxy to sidecar via HTTP localhost + short-lived token
3. Sidecar talks directly to OpenAI / Anthropic / Gemini (same as today)
4. Persistence: Rust owns native store (`tauri-plugin-store` or `sled`);
   sidecar reads via HTTP
5. Credentials: Rust via `keyring` crate (Windows Credential Manager);
   sidecar never touches secrets

## Backend split

| Layer | Tech | Responsibility |
|---|---|---|
| Renderer | React + Vite (current `src/`) | UI, type-safe `invoke` calls |
| Tauri shell | Rust | window/lifecycle, IPC whitelist, dialogs, shell, credentials, scoped fs, pty |
| Node sidecar | TS / Node (Runtime V2 ported as-is) | `@openai/agents`, turn-scheduler, EventStore, providers (Anthropic / Gemini / OpenAI formats), AJV schemas |
| HTTP bridge | `axum` (Rust) ↔ `fastify` or `express` (Node) | IPC between Tauri commands and sidecar |

### Why sidecar Node for Runtime V2

- `@openai/agents` is TS-first; a Rust rewrite is weeks of work for no real gain
- All 248 existing tests + CDP vertical slice remain valid as sidecar tests
- EventStore (state machine + JSONL) is a future Rust migration candidate
  (I/O-bound, perf wins likely)
- Provider format adapters (Anthropic / Gemini / OpenAI) stay in Node — they
  mirror the SDK wire format and have no perf reason to move

## Migration phases

| # | Scope | Duration | Validation |
|---|---|---|---|
| 1 | **Scaffold** — `tauri init` alongside `electron/`. Window, dialog, shell basics. Renderer points at Tauri. App launches. | 1-2 d | `npm run tauri:dev` opens Tauri window |
| 2 | **Sidecar** — Tauri spawns Node sidecar. HTTP bridge Rust↔Node. Migrate `electron/main/agent-runtime/*` to `node-sidecar/`. All IPC schemas become Tauri commands. | 2-3 d | Agent turn start / stream / interrupt works through sidecar |
| 3 | **Renderer** — Replace `window.electronAPI.*` calls with `invoke('cmd', args)`. Types in `src/types/`. All UI flows end-to-end. | 1-2 d | Manual smoke + CDP variant |
| 4 | **Persistence** — `electron-store` → `tauri-plugin-store`. `keytar` → `keyring` crate. Sidecar reads via HTTP. | 1 d | Settings persist across restarts |
| 5 | **Native features** — `node-pty` → `portable-pty` (if kept). Menu / tray Tauri equivalents. | 1-2 d | Terminal tool functional (if not removed) |
| 6 | **Cleanup** — Remove `electron/`, `electron-builder` config. `npm run tauri:dev` replaces `electron:dev`. | 1 d | Repo no longer references Electron |
| 7 | **Perf validation** — Measure cold start, RAM, bundle size. Profile agent runtime. Decide if EventStore Rust migration is worth it. | 1 d | Concrete numbers vs Electron baseline |

**Total estimate**: ~2 weeks uninterrupted.

## Performance targets

| Metric | Electron baseline | Tauri target |
|---|---|---|
| Installer size | ~150 MB (Chromium) | < 30 MB |
| Cold start | 1-2 s | < 500 ms |
| Idle RAM | 200-400 MB | < 150 MB |
| Agent turn throughput | baseline | +20% on Rust-cmd paths; unchanged for sidecar paths |

Targets are aspirational; Phase 7 measures actuals before committing to
follow-up Rust migrations.

## Risks and open questions

1. **CDP scripts** (`scripts/cdp-*.mjs`) test Electron via Chrome DevTools
   Protocol. Tauri exposes similar via WebView2 CDP, but scripts need porting.
   Decision: port incrementally as Tauri surfaces stabilize; do not block Phase 1.
2. **`node-pty` on Windows** — works but `portable-pty` Rust API differs. If the
   terminal tool is not critical to the product, consider removing it entirely
   rather than porting. Decision: defer to Phase 5 evaluation.
3. **AJV in sidecar** — current IPC JSON schemas stay in Node with AJV.
   Alternative: generate TS types and validate in Rust with `serde_json` +
   `jsonschema` crate. Keeping AJV in the sidecar is cheaper for v1.
4. **Auto-update** — `tauri-plugin-updater` is mature but UX differs from
   `electron-updater`. Not critical for v1; revisit after launch.
5. **Windows SDK** — must be completed (kernel32.lib missing) before any
   `cargo build` succeeds. This blocks Phase 1 from completing. Action: install
   via `winget` as the first execution step.
6. **Sidecar lifecycle** — Tauri must manage sidecar spawn, health checks,
   crash recovery, and graceful shutdown. `tauri-plugin-shell` provides primitives
   but a thin supervisor wrapper is needed. Design: Tauri spawns sidecar on
   `setup`, monitors via health endpoint, respawns on crash up to N times.
7. **Auth token between Tauri and sidecar** — short-lived token generated on
   sidecar startup, passed to Tauri via env var or stdin. Refresh on sidecar
   restart. Reject calls without valid token.

## Out of scope

- Mobile targets (iOS / Android) — Windows-only for v1
- Pure-Rust rewrite of `@openai/agents` adapter — deferred indefinitely
- Replacing React renderer — out of scope, no business reason
- Migrating AJV validation to Rust schemas — deferred

## Execution prerequisites

- [x] Rust 1.97.1 stable installed (`stable-x86_64-pc-windows-msvc`)
- [x] MSVC 2019 BuildTools available
- [ ] Windows SDK Lib / Include (kernel32.lib) — install via winget
- [ ] Discard working tree changes from Electron merge (`git checkout -- .`)
- [ ] Create migration branch (`git checkout -b feat/tauri-migration`)
- [ ] Install Tauri CLI (`cargo install tauri-cli` or via npm `@tauri-apps/cli`)
- [ ] `cargo install create-tauri-app` (or scaffold manually)

## Next step

Invoke the `writing-plans` skill to produce the detailed task list per phase,
with TDD-style task ordering (test first, then implementation, then validation).