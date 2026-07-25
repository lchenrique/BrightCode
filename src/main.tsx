import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { bootstrapProviders } from './lib/providers/bootstrap'
import { authStore } from './lib/providers/auth/store'
import { providerRegistry } from './lib/providers/registry'
import { projectsStore } from './lib/projects/store'

// In Electron, prime the in-memory credential cache before the first
// render so the chat picker doesn't briefly show "no models" while the
// IPC round-trip is in flight. In the browser this is a no-op.
void authStore.hydrate()
void projectsStore.hydrate()

bootstrapProviders()

// Expose the registry on `window` for DevTools / CDP inspection. Cheap
// (a single object reference) and useful for debugging the model picker
// without poking at React internals.
;(globalThis as { __brightcodeRegistry?: unknown }).__brightcodeRegistry = providerRegistry
;(window as { __brightcodeRegistry?: unknown }).__brightcodeRegistry = providerRegistry
console.log('[brightcode] registry exposed on window.__brightcodeRegistry')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
