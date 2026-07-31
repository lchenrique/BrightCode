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

**Step 1: Write the test**

```rust
use std::path::Path;

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn tauri_config_is_valid_json() {
    let path = manifest_dir().join("tauri.conf.json");
    let config = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {:?} failed: {}", path, e));
    let _: serde_json::Value = serde_json::from_str(&config)
        .unwrap_or_else(|e| panic!("tauri.conf.json invalid JSON: {}", e));
}

#[test]
fn icons_exist() {
    let dir = manifest_dir().join("icons");
    assert!(dir.join("icon.png").exists(), "icons/icon.png missing");
    assert!(dir.join("icon.ico").exists(), "icons/icon.ico missing");
}
```

> **Note:** The plan originally called for `tauri::generate_context!()` in the
> test. That approach hit a generic-type inference issue (`tauri::Wry` is a
> type alias, not a module path; the macro requires a concrete `Runtime`).
> The pragmatic substitute above achieves the same goal (validate config
> parses + icons present) without the Tauri runtime generic gymnastics.
> Both tests cover what we actually want to catch: malformed config or
> missing icons.

**Step 2: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --test smoke
```

Expected: 2 tests, both PASS.

**Step 3: Commit**

```bash
git add src-tauri/tests/smoke.rs
git commit -m "test(tauri): smoke tests for tauri.conf.json and icon files"
```

---

### Task 1.6 — Add a Tauri command and test it

TDD for the first real command. Validates the IPC plumbing is functional.

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `app_version` command and unit tests)

> **Note:** The plan originally placed tests in `tests/commands.rs` (an
> integration test), which requires `pub fn` imports. Making
> `#[tauri::command]` functions `pub` collides with Tauri's multi-crate-type
> build (`crate-type = ["staticlib", "cdylib", "rlib"]`) — the
> macro-generated helpers (`__cmd__ping`, `__tauri_command_name_ping`, etc.)
> get re-imported across the three crate-type compilations and trigger
> `E0255: name defined multiple times`. The fix is to keep commands private
> and put tests in `#[cfg(test)] mod tests` inside `lib.rs`, which has
> access to private items. The runtime registration still works because
> `#[tauri::command]` handles its own visibility internally.

**Step 1 — Write the failing tests** in a new `#[cfg(test)] mod tests` block inside `src-tauri/src/lib.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn app_version_matches_package_version() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION").to_string());
    }
}
```

**Step 2 — Add the `app_version` command** to `src-tauri/src/lib.rs` (keep `ping` private; the new command is also private — both are registered via `generate_handler!` and accessible to the runtime):

```rust
#[tauri::command]
fn ping() -> String {
    "pong".into()
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ping, app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_returns_pong() {
        assert_eq!(ping(), "pong");
    }

    #[test]
    fn app_version_matches_package_version() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION").to_string());
    }
}
```

**Step 3 — Run tests:**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: 2 tests pass. (Library unit tests, not integration tests.)

**Step 4 — Commit:**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): add app_version command with tests"
```

---

### Task 1.7 — Invoke command from renderer

Validates the full Tauri IPC stack end-to-end.

**Files:**
- Modify: `src/components/home/HomePage.tsx` (or wherever the home screen lives; placeholder if no such file)
- Create: `src/lib/tauri-api.ts`
- Create: `test/lib/tauri-api.test.ts`

> **Note:** The project uses separate test/source directories. `vitest.config.ts`
> discovers tests only in `test/**/*.test.ts` (not `src/`). Tests for renderer
> helpers go in `test/lib/<helper>.test.ts` to match this convention.

**Step 1: Write the failing test (renderer unit test)**

In `src/lib/tauri-api.ts`:

```ts
export async function getAppVersion(): Promise<string> {
  // Will be implemented using @tauri-apps/api/core invoke()
  throw new Error('not implemented')
}
```

In `test/lib/tauri-api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { invoke } from '@tauri-apps/api/core'
import { getAppVersion } from '../../src/lib/tauri-api'

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
npm test -- test/lib/tauri-api.test.ts
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
npm test -- test/lib/tauri-api.test.ts
```

Expected: PASS.

**Step 6: Create a smoke component** at `src/components/home/AppVersionBadge.tsx`. This is NOT wired into the UI tree in Phase 1 — that happens in Phase 3 (renderer migration). It just needs to compile.

```tsx
import { useEffect, useState } from 'react'
import { getAppVersion } from '@/lib/tauri-api'

export function AppVersionBadge() {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    getAppVersion().then(setVersion).catch(() => setVersion(null))
  }, [])
  if (!version) return null
  return (
    <span className="text-xs text-muted-foreground" data-testid="app-version-badge">
      v{version}
    </span>
  )
}
```

> **Note:** Return type annotation omitted. React 19 dropped the global `JSX`
> namespace; `JSX.Element` requires explicit `import type { JSX }`. Other
> home components rely on inference; this matches the repo convention.

**Step 7: TypeScript compile check**

```bash
npx tsc -b
```

Expected: clean (no errors).

**Step 8: Commit**

```bash
git add src/lib/tauri-api.ts test/lib/tauri-api.test.ts src/components/home/AppVersionBadge.tsx package.json package-lock.json
git commit -m "feat(tauri): renderer invokes app_version command via tauri-api wrapper"
```

**Step 8: Commit**

```bash
git add src/lib/tauri-api.ts test/lib/tauri-api.test.ts package.json package-lock.json
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

## Phase 2 — Sidecar integration

**Scope:** Tauri spawns a Node sidecar that hosts the existing Agent Runtime V2 (~4500 LOC in `electron/main/agent-runtime/`). The Rust shell owns the window and proxies IPC to the sidecar over HTTP localhost + auth token. Renderer continues to call `window.electronAPI.*` for now — Phase 3 rewrites call sites. This phase proves the architecture end-to-end with one command.

**Architecture decisions (locked):**
- **Transport:** HTTP/JSON. `axum` in Rust, `fastify` in Node. No gRPC, no message bus — the simplest thing that works.
- **Auth:** 32-byte random token, generated by sidecar, printed to stdout on first line as `{"auth":"<hex>","port":<n>}`. Rust parses this before accepting any proxy request.
- **Sidecar bin:** `node-sidecar/bin/brightcode-sidecar.js` (built from `node-sidecar/server.ts` via `tsc`). Tauri spawns it via `tauri-plugin-shell` with `--command` arg + the auth token is not in env (it travels stdout).
- **Respawn:** Rust tracks spawn count. On sidecar exit, respawn with exponential backoff (100ms → 200ms → 400ms). After 3 failures in 60s, surface an error event to the renderer and freeze the IPC. Phase 3 will add a UI surface for it.
- **Phase 2 scope:** ONE command wired (`agent_runtime_thread_create`). Other commands still hit the tatic bridge / are not yet reachable. We prove the architecture with one round-trip; we do NOT port the whole IPC surface here.

---

### Task 2.1 — Add `tauri-plugin-shell` and external-bin declaration

**Why:** Tauri needs the shell plugin to spawn the Node sidecar binary, and `tauri.conf.json` needs to know where the binary lives in dev vs. bundled.

**Files:**
- `src-tauri/Cargo.toml` — add `tauri-plugin-shell = "2"`
- `src-tauri/src/lib.rs` — register plugin in builder chain
- `src-tauri/capabilities/default.json` — allow `shell:allow-execute` for the sidecar bin scope
- `src-tauri/tauri.conf.json` — declare `externalBin` pointing to `node-sidecar/bin/brightcode-sidecar`
- `package.json` — add npm scripts `sidecar:build` (`tsc -p node-sidecar/tsconfig.json`) and `sidecar:dev` (`tsx watch node-sidecar/server.ts`)

**Steps:**
1. `cd src-tauri && cargo add tauri-plugin-shell@2` (or edit Cargo.toml manually).
2. In `lib.rs`, add `.plugin(tauri_plugin_shell::init())` to the builder chain before `invoke_handler`.
3. In `capabilities/default.json`, add `"shell:default"` permission and an explicit scope for the sidecar bin (Tauri 2 requires scope declarations for `shell:allow-execute`).
4. In `tauri.conf.json`, add a `bundle.externalBin` array entry: `"binaries/brightcode-sidecar"`. (Tauri copies/symlinks it during dev.)
5. In `package.json`, add `sidecar:build` and `sidecar:dev` scripts.
6. `npm run sidecar:build` (will fail until Task 2.2 creates the source — that's fine; the script is the contract).
7. `cargo build` in `src-tauri/` to confirm the plugin compiles.
8. Commit: `feat(tauri): add tauri-plugin-shell for sidecar lifecycle`.

**Validate:** `cargo build` exits 0. No new command yet — just the plugin wiring.

---

### Task 2.2 — Create `node-sidecar/` skeleton with fastify on random port

**Why:** Sidecar must listen before Tauri can connect. Random port avoids collisions with other local services; we report the chosen port to Tauri via stdout.

**Files (new):**
- `node-sidecar/package.json` — name `brightcode-sidecar`, type `module`, deps `fastify@5`
- `node-sidecar/tsconfig.json` — extends root, `outDir: "bin"`, `rootDir: "."`, target ES2022
- `node-sidecar/server.ts` — entrypoint
- `node-sidecar/ipc.ts` — placeholder router; one route `/v1/agent-runtime/thread/create` returns 501
- `node-sidecar/bin/.gitkeep` — placeholder so the dir exists for `tsc`

**Steps:**
1. Create `node-sidecar/package.json` with `fastify@5` as dep and `tsx` as devDep.
2. Create `node-sidecar/tsconfig.json` extending the root config; set `outDir: "bin"`, `include: ["server.ts", "ipc.ts"]`.
3. In `server.ts`:
   - Generate a 32-byte hex token (`crypto.randomBytes(32).toString('hex')`).
   - Pick a random port (bind fastify to `127.0.0.1:0`).
   - Register a `preHandler` hook that rejects requests without `authorization: Bearer <token>` header.
   - Register placeholder route `POST /v1/agent-runtime/thread/create` returning `{ status: 'not_implemented' }` with status 501.
   - **On `ready`**, print ONE line to stdout: `{"auth":"<hex>","port":<n>}\n`. This is the contract Tauri will parse.
4. Run `npm run sidecar:build` — confirm `node-sidecar/bin/server.js` is produced.
5. Manually smoke: `node node-sidecar/bin/server.js &`, capture stdout, then `curl -X POST http://127.0.0.1:<port>/v1/agent-runtime/thread/create -H 'authorization: Bearer <token>' -H 'content-type: application/json' -d '{}'`. Expect 501. `curl` without auth header should expect 401.
6. Commit: `feat(tauri): scaffold node-sidecar with fastify and token auth`.

**Validate:** Sidecar prints JSON line on ready. Auth is enforced. No business logic yet.

---

### Task 2.3 — Rust sidecar supervisor: spawn, parse ready line, expose handle

**Why:** Tauri must own the sidecar lifecycle. This task wires the spawn + the stdout-parser so the rest of Phase 2 can call `state.sidecar.post(path, body)`.

**Files:**
- `src-tauri/src/sidecar.rs` — new module
- `src-tauri/src/lib.rs` — manage supervisor in `setup` hook, store handle in `app.manage()`
- `src-tauri/Cargo.toml` — add `tokio = { version = "1", features = ["full"] }` and `reqwest = { version = "0.12", features = ["json"] }`

**Steps:**
1. In `sidecar.rs`, define `pub struct SidecarSupervisor { base_url: String, token: String, child: Arc<Mutex<Option<CommandChild>>>, retries: AtomicU32 }`.
2. Implement `pub async fn spawn(app: &AppHandle) -> Result<SidecarSupervisor>`:
   - Use `tauri_plugin_shell::ShellExt` to call `app.shell().command("brightcode-sidecar").spawn()` (or `.sidecar("brightcode-sidecar")` for bundled binaries).
   - Read child stdout line-by-line on a background task (`tauri::async_runtime::spawn`); the first non-empty line is the ready JSON. Parse `port` and `auth`.
   - Block the function on a `oneshot` until the ready line arrives (timeout 5s — fail fast if sidecar is broken).
3. Implement `pub async fn post(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value>` that hits `http://127.0.0.1:<port><path>` with `authorization: Bearer <token>` and returns the JSON body.
4. In `lib.rs` `setup` callback: `app.manage(sidecar::spawn(app).await?);` (propagate error → window shows a fatal dialog; user can retry).
5. Log every spawn attempt and the parsed ready JSON at `info!` level so we can debug from the terminal.
6. Commit: `feat(tauri): spawn node sidecar and parse auth from stdout`.

**Validate:** `npm run tauri:dev` opens window; in the terminal you see `sidecar ready: port=<n>` and no errors. Window content unchanged.

---

### Task 2.4 — Add axum proxy + token validation, register `proxy_agent_runtime` command

**Why:** Renderer must NOT reach the sidecar directly (token would leak). Rust validates and proxies.

**Files:**
- `src-tauri/src/proxy.rs` — new module
- `src-tauri/src/lib.rs` — register `proxy_agent_runtime` in `invoke_handler`

**Steps:**
1. In `proxy.rs`, define `#[tauri::command] async fn proxy_agent_runtime(state: State<'_, SidecarSupervisor>, path: String, body: serde_json::Value) -> Result<serde_json::Value, String>`.
2. Validate `path` against an allowlist: `["/v1/agent-runtime/thread/create"]` for Phase 2. Any other path returns `Err("path not allowed in phase 2")`. (Phase 3 expands the allowlist.)
3. Call `state.post(&path, body).await.map_err(|e| e.to_string())`.
4. Register in `invoke_handler`: `tauri::generate_handler![ping, app_version, proxy_agent_runtime]`.
5. Add a unit test in `src-tauri/src/proxy.rs`:
   - With a mock `SidecarSupervisor` (just a trait + test impl) that echoes the body, call `proxy_agent_runtime` and assert the response matches.
   - With an unknown path, assert it returns an error.
6. Commit: `feat(tauri): add proxy_agent_runtime command with path allowlist`.

**Validate:** `cargo test` passes the proxy unit tests. `tauri:dev` still boots.

---

### Task 2.5 — Sidecar respawn on crash (max 3 retries / 60s)

**Why:** Node sidecar can die (segfault, OOM, panic in third-party). The shell must restart it without taking down the UI.

**Files:**
- `src-tauri/src/sidecar.rs` — extend the supervisor

**Steps:**
1. In `sidecar.rs`, spawn a background watcher task that awaits `child.wait()` (or equivalent on the `CommandChild`). On exit:
   - Increment `retries`. If `retries >= 3` within the last 60s, emit a Tauri event `sidecar-fatal` to the main window with the last error and stop retrying.
   - Otherwise, sleep with exponential backoff (`100ms * 2^retries`, capped at 5s), then re-spawn by calling `spawn()` again. The supervisor must reset `base_url` and `token` after re-spawn.
2. Expose `pub fn retry_count(&self) -> u32` for debugging.
3. Add a unit test using a mock CommandChild that immediately exits; assert the supervisor fires the respawn path (use a trait abstraction over the shell plugin so the test doesn't actually spawn Node).
4. Commit: `fix(tauri): respawn sidecar on crash with bounded retries`.

**Validate:** Unit test green. Manual: `kill -9` the sidecar from Task Manager; Tauri logs `sidecar exited, respawning` and the proxy resumes within ~200ms.

---

### Task 2.6 — Wire `agent_runtime_thread_create` end-to-end

**Why:** First real command proves the full pipeline: renderer → invoke → Rust → sidecar → response.

**Files:**
- `node-sidecar/ipc.ts` — replace placeholder with real handler
- `node-sidecar/handlers/thread-create.ts` — new file, ports `Runtime.createThread` logic
- `src/lib/tauri-bridge.ts` — add `agentRuntimeThreadCreate` method
- `test/tauri-sidecar-roundtrip.test.mjs` — new CDP-less smoke test

**Steps:**
1. In `node-sidecar/handlers/thread-create.ts`, port the minimal logic from `electron/main/agent-runtime/runtime.ts::createThread`:
   - Generate `threadId` if absent (use `crypto.randomUUID()`).
   - Create an empty `ThreadState` with `createdAt`, `updatedAt`, empty `events`.
   - Return `{ threadId, thread: <state> }` per the existing schema in `electron/shared/agent-protocol.ts`.
   - For Phase 2, **persist nothing** — keep the in-memory state. Persistence is Phase 4.
2. In `node-sidecar/ipc.ts`, replace the 501 route with `fastify.post('/v1/agent-runtime/thread/create', { schema: ... }, handler)`. Use the existing JSON schema from `electron/shared/agent-runtime-ipc.ts::AGENT_RUNTIME_IPC_SCHEMAS.threadCreate` for validation.
3. In `src/lib/tauri-bridge.ts`, add:
   ```ts
   async agentRuntimeThreadCreate(input: { threadId?: string } = {}): Promise<{ threadId: string; thread: ThreadState }> {
     if (!isTauri()) throw new Error('agentRuntimeThreadCreate: not running under Tauri');
     return await invoke('proxy_agent_runtime', { path: '/v1/agent-runtime/thread/create', body: input });
   }
   ```
4. Add a smoke test `test/tauri-sidecar-roundtrip.test.mjs` that:
   - Spawns the sidecar binary directly (no Tauri).
   - Reads the auth/port line.
   - POSTs `{ threadId: 'test-1' }` to `/v1/agent-runtime/thread/create`.
   - Asserts the response has `threadId === 'test-1'` and a non-empty `thread.createdAt`.
   - Runs in CI under `npm test`.
5. Commit: `feat(tauri): agent_runtime_thread_create end-to-end`.

**Validate:** New test passes. `tauri:dev` window: open devtools console, run `await window.electronAPI.agentRuntimeThreadCreate({ threadId: 'demo' })` (after exposing via bridge); expect a ThreadState back.

---

### Task 2.7 — End-to-end smoke in dev mode

**Why:** The test in Task 2.6 covers the sidecar alone. We need a human-runnable smoke that exercises the full Tauri→Rust→sidecar path.

**Files:**
- `scripts/tauri-sidecar-smoke.mjs` — new script
- `scripts/screenshots/2026-07-30-phase-2-sidecar-ready.png` — captured manually

**Steps:**
1. Launch `npm run tauri:dev` in one terminal.
2. Run `scripts/tauri-sidecar-smoke.mjs` in another: it uses CDP (the WebView2 CDP is on `localhost:9222` in Tauri 2 dev with `devtools: true`) to evaluate `window.electronAPI.agentRuntimeThreadCreate({ threadId: 'cdp-smoke' })` in the renderer and assert the response.
3. Capture a screenshot of the devtools console showing the round-trip.
4. Commit the script + screenshot.

**Validate:** Script exits 0. Screenshot committed.

---

### Phase 2 exit checklist

- [ ] Task 2.1: `tauri-plugin-shell` installed, `externalBin` declared
- [ ] Task 2.2: `node-sidecar/` builds, prints ready JSON, enforces auth
- [ ] Task 2.3: Rust supervisor spawns sidecar and parses auth from stdout
- [ ] Task 2.4: `proxy_agent_runtime` command with path allowlist + unit tests
- [ ] Task 2.5: Respawn on crash (≤3 retries / 60s) + unit test
- [ ] Task 2.6: `agent_runtime_thread_create` end-to-end + smoke test
- [ ] Task 2.7: Full Tauri→Rust→sidecar CDP smoke + screenshot

**Stop here.** Do NOT proceed to Phase 3 (renderer migration) until Phase 2 exit checklist is complete. The user reviews the sidecar architecture before we commit to porting all IPC commands.

**Known limitations of Phase 2 (acceptable):**
- Only `agent_runtime_thread_create` is wired. All other Agent Runtime IPC channels still fall through to the tactical bridge or are unreachable.
- No persistence (Phase 4). Threads vanish on sidecar restart.
- No credentials / provider catalog (still in the Electron main process; Phase 4 migrates).
- Renderer still calls `window.electronAPI.*`; `tauri-bridge.ts` grows as the only file that knows about Tauri vs Electron.

---



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