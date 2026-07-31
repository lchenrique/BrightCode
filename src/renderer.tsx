import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { agentStore } from './lib/agents'
import { bootstrapProviders } from './lib/providers/bootstrap'
import { authStore } from './lib/providers/auth/store'
import { providerRegistry } from './lib/providers/registry'
import { projectsStore } from './lib/projects/store'

bootstrapProviders()
void authStore.hydrate()
void agentStore.hydrate()
void projectsStore.hydrate()

;(globalThis as { __brightcodeRegistry?: unknown }).__brightcodeRegistry = providerRegistry
;(window as { __brightcodeRegistry?: unknown }).__brightcodeRegistry = providerRegistry

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
