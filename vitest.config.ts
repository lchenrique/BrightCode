/**
 * Vitest configuration for the BrightCode agent runtime tests.
 *
 * Runs against compiled .ts files via tsconfig paths aliases.
 * Tests live in `test/agent-runtime/` and mirror the source structure
 * under `electron/` and `src/`.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Use native Vite tsconfig paths resolution (Vitest v4 way).
    tsconfigPaths: true,
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
    exclude: ['test/**/node_modules/**'],
    // Deterministic environment — no browser, no Electron.
    environment: 'node',
    // Clear mocks between tests.
    clearMocks: true,
  },
})
