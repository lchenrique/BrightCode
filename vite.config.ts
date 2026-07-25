import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron/simple'

// When `ELECTRON=1` is set (e.g. `npm run electron:dev`), we run the app
// inside an Electron window with a main process + preload script. Otherwise
// we just run Vite as a plain web dev server for fast UI iteration in the
// browser. Both modes share the same renderer source.
const isElectron = process.env.ELECTRON === '1'

/**
 * Writes `{ "type": "module" }` into `out/main/` and `out/preload/` after
 * the build. Electron's main process + preload run as ESM in this project
 * (Vite outputs `import` statements), and Node uses the local `type`
 * field to decide module system. The project root has `"type": "module"`,
 * so we re-declare it explicitly in each Electron entry dir to be safe
 * against future root changes.
 */
function electronEsmPackageJsonPlugin(): Plugin {
  return {
    name: 'brightcode:electron-esm-package-json',
    apply: () => isElectron,
    closeBundle() {
      for (const dir of ['out/main', 'out/preload']) {
        writeFileSync(
          path.resolve(__dirname, dir, 'package.json'),
          JSON.stringify({ type: 'module' }, null, 2) + '\n',
        )
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    electronEsmPackageJsonPlugin(),
    electron({
      main: {
        entry: 'electron/main/index.ts',
        vite: {
          build: {
            outDir: 'out/main',
            rollupOptions: {
              external: ['electron-store', 'keytar'],
            },
          },
        },
      },
      preload: {
        input: path.resolve(__dirname, 'electron/preload/index.ts'),
        vite: {
          build: {
            outDir: 'out/preload',
            rollupOptions: {
              output: {
                // Electron auto-detects module format by file extension.
                // `.cjs` is required because our root `package.json` has
                // `"type": "module"` (which would force `.mjs` to ESM and
                // break the CJS `require('electron')` the Vite output emits).
                entryFileNames: '[name].cjs',
                format: 'cjs',
                inlineDynamicImports: true,
              },
            },
          },
        },
      },
      // Renderer needs Node access gated through preload — no integration.
      renderer: undefined,
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: isElectron
    ? { port: 5180, strictPort: true }
    : undefined,
  // Avoid `optimizeDeps` from pre-bundling the main process deps.
  optimizeDeps: {
    exclude: ['electron-store', 'keytar'],
  },
})
