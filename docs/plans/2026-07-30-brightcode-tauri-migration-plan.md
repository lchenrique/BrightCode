# BrightCode Tauri Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate BrightCode from Electron to Tauri (hybrid: Rust shell + Node sidecar) in 7 phases, preserving the Agent Runtime V2 (`@openai/agents` integration) as a Node sidecar.

**Architecture:** Tauri 2 Rust shell owns windowing, IPC whitelist, native plugins (dialog, shell, store, credential, pty). A Node.js sidecar runs the existing Agent Runtime V2 unchanged. Tauri commands proxy to the sidecar over HTTP localhost + auth token. Renderer (React + Vite) replaces `window.electronAPI.*` with `invoke('cmd', args)`.

**Tech Stack:** Tauri 2 (Rust), `@tauri-apps/cli`, `@tauri-apps/api`, React + Vite (existing), Node.js sidecar (existing Runtime V2), `axum` (Rust HTTP), `fastify` (Node HTTP), `keyring` crate, `tauri-plugin-store`, `portable-pty`.

**Design doc:** [2026-07-30-brightcode-tauri-migration.md](./2026-07-30-brightcode-tauri-migration.md) — full rationale, decisions, risks.

**Working directory:** this plan assumes a feature branch `feat/tauri-migration` checked out from `master` after discarding uncommitted Electron artifacts. See Prerequisites below.

---

## Prerequisites (before Phase 1)

These are setup tasks, not implementation. Complete before Task 1.

### P.1 — Discard uncommitted Electron working tree

The Electron merge left 4 modified files that won't survive the Tauri pivot:
- `electron/main/agent-runtime/event-store.ts` (state-only-after-write fix)
- `electron/main/agent-runtime/turn-scheduler.ts` (auto-merge artifact)
- `test/agent-runtime/event-store-persistence.test.ts` (local-only test)
- `vite.config.ts` (require shim + externalize builtins)

```bash
git checkout -- electron/main/agent-runtime/event-store.ts \
               electron/main/agent-runtime/turn-scheduler.ts \
               test/agent-runtime/event-store-persistence.test.ts \
               vite.config.ts
git status --short   # expect: clean
```

### P.2 — Install Windows SDK Lib / Include

Tauri build links against `kernel32.lib` etc. Currently missing from system.

```bash
winget install Microsoft.WindowsSDK.10.0.22621 --accept-package-agreements --accept-source-agreements
# Restart any open shells after install
```

Verify:
```bash
find "/c/Program Files (x86)/Windows Kits/10/Lib" -name "kernel32.lib" 2>/dev/null | head -1
# Expected: at least one path printed
```

### P.3 — Create migration branch

```bash
git checkout -b feat/tauri-migration
git push -u origin feat/tauri-migration
```

### P.4 — Install Tauri CLI

Two options, choose one:

**Option A — npm package** (matches the project's Node tooling):
```bash
npm install --save-dev @tauri-apps/cli
```

**Option B — cargo** (system-wide, not in package.json):
```bash
cargo install tauri-cli --version "^2.0"
```

The plan assumes Option A.

---

## Phase 1 — Scaffold

**Scope:** Tauri shell launches with a placeholder window. Renderer (the existing React app) loads inside it. No sidecar, no migration of IPC handlers yet — just prove the shell works.

**Exit criteria:**
- `npm run tauri:dev` opens a Tauri window
- Window shows the existing BrightCode React UI (loading or home screen)
- `tauri.conf.json` configured with sensible defaults
- CI-friendly headless smoke test confirms the bundle builds

### Task 1.1 — Install Tauri Rust crate dependencies

**Files:**
- Modify: `package.json`

**Step 1: Add Tauri CLI dev dependency**

```bash
npm install --save-dev @tauri-apps/cli@^2
```

Expected: `package.json` devDependencies gains `@tauri-apps/cli`.

**Step 2: Verify install**

```bash
npx tauri --version
```

Expected: prints Tauri CLI version (e.g. `tauri-cli 2.x.y`).

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(tauri): add @tauri-apps/cli dev dependency"
```

---

### Task 1.2 — Scaffold Tauri Rust crate

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/icons/icon.png` (placeholder, replace later)
- Create: `src-tauri/.gitignore`

**Step 1: Write Cargo.toml**

```toml
[package]
name = "brightcode"
version = "0.1.0"
edition = "2021"
rust-version = "1.77"

[lib]
name = "brightcode_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

**Step 2: Write build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

**Step 3: Write src-tauri/src/main.rs**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    brightcode_lib::run();
}
```

**Step 4: Write src-tauri/src/lib.rs (minimal run() function)**

```rust
#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**Step 5: Write tauri.conf.json**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "BrightCode",
  "version": "0.1.0",
  "identifier": "dev.brightcode.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5180",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "BrightCode",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/icon.png"
    ]
  }
}
```

**Step 6: Write capabilities/default.json**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default"
  ]
}
```

**Step 7: Generate placeholder icon**

```bash
mkdir -p src-tauri/icons
# Use any 1024x1024 PNG; a solid color is fine for scaffold
node -e "const fs=require('fs');const buf=Buffer.alloc(1024*1024*4);for(let i=0;i<1024*1024;i++){buf[i*4]=30;buf[i*4+1]=30;buf[i*4+2]=46;buf[i*4+3]=255;}fs.writeFileSync('src-tauri/icons/icon.png',buf);"
# Tauri requires .ico for Windows builds; copy as placeholder
node -e "require('fs').copyFileSync('src-tauri/icons/icon.png','src-tauri/icons/icon.ico')"
```

Note: replace with real icon before any release build.

**Step 8: Write src-tauri/.gitignore**

```
target/
gen/
WixTools/
```

**Step 9: Verify Tauri builds (no test yet, this is a smoke check)**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: compiles successfully. First build will pull ~300 crates and take several minutes. Warnings about unused `serde` / `serde_json` are OK at this stage.

**Step 10: Commit**

```bash
git add src-tauri/
git commit -m "feat(tauri): scaffold Rust crate with minimal lib.rs"
```

---

### Task 1.3.5 — Migrate vite.config.ts to Tauri (inserted during Phase 1)

**Files:**
- Modify: `vite.config.ts`

**Why inserted:** Task 1.4 smoke test revealed the existing `vite.config.ts`
still loads `vite-plugin-electron/simple` (which builds `out/main/` artifacts
and spawns Electron) and gates `server.port: 5180` behind `isElectron`. With
Tauri, vite must serve on 5180 unconditionally and Electron plugin must be
fully removed.

**Step 1 — Replace `vite.config.ts` with Tauri-only config**

```ts
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
  },
})
```

Removes:
- `vite-plugin-electron/simple` import and registration
- `electronEsmPackageJsonPlugin` function and call
- `isElectron` conditional
- `optimizeDeps.exclude` (electron-store/keytar/node-pty — no longer bundled)

Keeps:
- React, Tailwind plugins
- `@` alias to `./src`
- Port 5180 (now unconditional; browser dev workflow must use this port)

**Step 2 — Delete stale Electron build artifacts**

```bash
rm -rf out/main out/preload
git status --short  # expect: only vite.config.ts modified
```

**Step 3 — Smoke verify vite serves on 5180**

```bash
npm run dev > /tmp/vite-check.log 2>&1 &
VITE_PID=$!
sleep 8
netstat -ano | grep ":5180" | grep LISTENING | head -1
# Expected: at least one line showing LISTENING
kill $VITE_PID 2>/dev/null
tail -5 /tmp/vite-check.log
```

If vite is NOT listening on 5180, the port config didn't take effect —
check the file matches exactly.

**Step 4 — Commit**

```bash
git add vite.config.ts
git commit -m "chore(vite): remove electron plugin, serve on 5180 for tauri"
```

**Step 5 — Verify `out/` was deleted and git is clean of Electron artifacts**

```bash
ls out/ 2>&1
# Expected: 'No such file or directory'
git status --short
# Expected: only the commit, no extra changes
```

### Task 1.3 — Wire npm scripts to launch Tauri

**Files:**
- Modify: `package.json`

**Step 1: Add Tauri scripts**

Edit `package.json` scripts section:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build",
    "lint": "oxlint",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

(Removes `electron:dev` and `electron:build`. Keep `electron:preview` removed too — no longer applicable.)

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore(scripts): replace electron scripts with tauri scripts"
```

---

### Task 1.4 — Confirm Tauri shell launches

This is the first manual smoke test of the integrated stack. No automated test yet — Tauri's headless integration testing requires `tauri-driver` (WebDriver), which we add in Phase 6.

**Step 1: Start Tauri dev**

```bash
npm run tauri:dev
```

Expected: Vite starts on port 5180, then a Tauri window opens titled "BrightCode" showing the React app.

**Step 2: Verify window contents**

Open DevTools in the Tauri window (right-click → Inspect). Confirm:
- React app renders (look for any component)
- `window.__TAURI_INTERNALS__` exists in console (proves Tauri context loaded)

**Step 3: Stop the dev server**

Press `Ctrl+C` in the shell running `tauri:dev`.

**Step 4: Document any deviations**

If the window doesn't open or the React app fails to load, stop. Investigate before proceeding. Common causes:
- Vite dev server not running on port 5180 (check `devUrl` in tauri.conf.json)
- CSP blocking renderer assets
- Missing icon file (Tauri warns but should not fail)

---

### Task 1.5 — Write a smoke unit test for the Rust side

TDD applies: write a failing test, then implement, then verify.

**Files:**
- Create: `src-tauri/tests/smoke.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn tauri_context_generates_without_panic() {
    // Smoke: the generate_context! macro must succeed
    // (this will fail until tauri.conf.json is valid)
    let _ctx = tauri::generate_context!();
}
```

**Step 2: Run test to verify it passes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test smoke
```

Expected: PASS. If FAIL, check `tauri.conf.json` validity.

**Step 3: Commit**

```bash
git add src-tauri/tests/smoke.rs
git commit -m "test(tauri): smoke test for context generation"
```

---

### Task 1.6 — Add a Tauri command and test it

TDD for the first real command. Validates the IPC plumbing is functional.

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/commands.rs`

**Step 1: Write the failing test**

In `src-tauri/tests/commands.rs`:

```rust
use brightcode_lib::ping;

#[test]
fn ping_returns_pong() {
    assert_eq!(ping(), "pong");
}
```

**Step 2: Run test to verify it passes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test commands
```

Expected: PASS (ping was implemented in Task 1.2).

**Step 3: Add a failing test for a new command**

In `src-tauri/src/lib.rs`, modify to expose a stub:

```rust
#[tauri::command]
pub fn app_version() -> String {
    unimplemented!()
}
```

Then update `tests/commands.rs`:

```rust
use brightcode_lib::{ping, app_version};

#[test]
fn ping_returns_pong() {
    assert_eq!(ping(), "pong");
}

#[test]
fn app_version_matches_package_version() {
    assert_eq!(app_version(), env!("CARGO_PKG_VERSION").to_string());
}
```

**Step 4: Run test to verify it fails**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test commands app_version
```

Expected: FAIL with "not yet implemented" panic.

**Step 5: Implement minimal code**

In `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
```

Update the `invoke_handler!` macro:

```rust
.invoke_handler(tauri::generate_handler![ping, app_version])
```

**Step 6: Run test to verify it passes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test commands
```

Expected: PASS for both tests.

**Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/tests/commands.rs
git commit -m "feat(tauri): add app_version command with test"
```

---

### Task 1.7 — Invoke command from renderer

Validates the full Tauri IPC stack end-to-end.

**Files:**
- Modify: `src/components/home/HomePage.tsx` (or wherever the home screen lives; placeholder if no such file)
- Create: `src/lib/tauri-api.ts`

**Step 1: Write the failing test (renderer unit test)**

In `src/lib/tauri-api.ts`:

```ts
export async function getAppVersion(): Promise<string> {
  // Will be implemented using @tauri-apps/api/core invoke()
  throw new Error('not implemented')
}
```

In `src/lib/tauri-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { getAppVersion } from './tauri-api'

describe('tauri-api', () => {
  it('getAppVersion invokes app_version command', async () => {
    vi.mocked(invoke).mockResolvedValue('0.1.0')
    const version = await getAppVersion()
    expect(invoke).toHaveBeenCalledWith('app_version')
    expect(version).toBe('0.1.0')
  })
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- src/lib/tauri-api.test.ts
```

Expected: FAIL with "not implemented".

**Step 3: Implement minimal code**

In `src/lib/tauri-api.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

export async function getAppVersion(): Promise<string> {
  return invoke<string>('app_version')
}
```

**Step 4: Install @tauri-apps/api**

```bash
npm install @tauri-apps/api@^2
```

**Step 5: Run test to verify it passes**

```bash
npm test -- src/lib/tauri-api.test.ts
```

Expected: PASS.

**Step 6: Use it in a component (manual smoke)**

In any renderer component (e.g., add to the existing footer):

```tsx
import { useEffect, useState } from 'react'
import { getAppVersion } from '@/lib/tauri-api'

// ...inside component:
const [version, setVersion] = useState('')
useEffect(() => {
  getAppVersion().then(setVersion).catch(console.error)
}, [])
// ...render: <span>v{version}</span>
```

**Step 7: Manual smoke**

```bash
npm run tauri:dev
```

Expected: version string appears in the Tauri window.

**Step 8: Commit**

```bash
git add src/lib/tauri-api.ts src/lib/tauri-api.test.ts package.json package-lock.json
git commit -m "feat(tauri): renderer invokes app_version command"
```

---

### Phase 1 exit checklist

- [x] Task 1.1: Tauri CLI installed
- [x] Task 1.2: Rust crate scaffolded with `ping` and `app_version`
- [x] Task 1.3: npm scripts replaced
- [x] Task 1.4: `tauri:dev` opens a window
- [x] Task 1.5: smoke test passes
- [x] Task 1.6: command test passes
- [x] Task 1.7: renderer invokes a command and renders its result

**Stop here.** Do NOT proceed to Phase 2 until Phase 1 exit checklist is complete. The user reviews the scaffold before sidecar integration begins.

---

## Phase 2 — Sidecar integration (outline)

**Scope:** Tauri spawns Node sidecar. HTTP bridge in Rust ↔ HTTP server in Node. Migrate IPC handler skeleton.

### Key tasks (to be expanded when phase starts)

1. Add `tauri-plugin-shell` for sidecar lifecycle
2. Create `node-sidecar/` directory; port `electron/main/agent-runtime/index.ts` as `node-sidecar/server.ts`
3. Add HTTP server in sidecar (fastify) on random localhost port
4. Add auth token generation in sidecar startup; pass to Tauri via stdout
5. Add `axum` server in Rust that proxies sidecar HTTP, validates token
6. First end-to-end command: `agent_runtime_thread_create` (simplest in the schema)
7. Smoke: invoke from renderer → Rust proxy → Node sidecar → response back

### Phase 2 exit criteria

- One full round-trip IPC works (any single command)
- Auth token validated
- Sidecar crash triggers Tauri respawn (up to 3 retries)

---

## Phase 3 — Renderer migration (outline)

### Key tasks

1. Audit all `window.electronAPI.*` calls in `src/`
2. Generate Tauri command bindings in `src/lib/tauri-bindings/`
3. Replace each `electronAPI.X` with `invoke('X', args)` equivalent
4. Remove `electron/preload/index.ts`
5. Update `tsconfig.json` to remove electron types

### Phase 3 exit criteria

- All UI flows work via Tauri commands (manual + CDP variant)
- Zero references to `window.electronAPI`
- `tsc -b` clean

---

## Phase 4 — Persistence (outline)

### Key tasks

1. Add `tauri-plugin-store` for settings persistence
2. Migrate `electron-store` usages in sidecar to HTTP reads from Rust
3. Add `keyring` crate; replace `keytar` for credentials
4. Update `AgentRuntimeProviderResolver` to fetch credentials via Tauri command

### Phase 4 exit criteria

- Settings persist across app restarts
- Credentials stored in Windows Credential Manager
- No secrets in sidecar memory

---

## Phase 5 — Native features (outline)

### Key tasks

1. Evaluate `portable-pty` vs removing terminal feature
2. Add Tauri menu / tray if used
3. Migrate `node-pty` calls (if kept)

### Phase 5 exit criteria

- Terminal tool functional OR removed from product with no breakage
- Native menu / tray match Electron behavior

---

## Phase 6 — Cleanup (outline)

### Key tasks

1. Remove `electron/` directory
2. Remove `electron-builder` config from `package.json`
3. Remove unused deps (`electron-store`, `keytar`, `node-pty`, etc.)
4. Port CDP scripts (`scripts/cdp-*.mjs`) to Tauri / WebView2 CDP
5. Update `README.md` with new dev workflow

### Phase 6 exit criteria

- Repo contains zero references to Electron
- `npm run tauri:dev` is the canonical dev command
- CI green

---

## Phase 7 — Performance validation (outline)

### Key tasks

1. Build release binary; measure installer size
2. Measure cold start time (kill process → start → window painted)
3. Measure idle RAM after 60s
4. Profile agent runtime to identify hot paths
5. Decision gate: is Rust migration of EventStore worth it? If yes, write a new plan for that work; if no, document the rationale

### Phase 7 exit criteria

- Concrete numbers vs Electron baseline published in a perf report doc
- Decision recorded in bright-memory

---

## Open questions resolved during execution

- (none yet — fill in as encountered)

## Notes for the executing engineer

- TDD where it makes sense; manual smoke for Tauri window content (CDP-based testing in Phase 6)
- Commit frequently per task; never end a session with uncommitted changes
- Update bright-memory after each phase
- If a task blocks on Windows SDK install or another env issue, fix it as a separate prerequisite commit — don't bundle with feature work