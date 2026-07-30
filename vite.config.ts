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
    watch: {
      // Ignore the Tauri Rust build output. Cargo writes to src-tauri/target/
      // while tauri:dev is running, which races with Vite's file watcher and
      // produces EBUSY errors. Tauri's own watcher handles src-tauri/ rebuilds.
      ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'],
    },
  },
})
