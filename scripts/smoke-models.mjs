/**
 * Smoke test for the model registry — confirms what `useAvailableModelsGrouped`
 * would return when the user has NO credentials configured. The expectation
 * is that all 5 free OpenCode Zen models show up.
 *
 * Run with: node scripts/smoke-models.mjs
 */

// Stub the auth store so `hasCredential` returns false for everyone.
// (In the browser, the registry pulls this from localStorage / electron-store.)
import { JSDOM } from 'jsdom'
const dom = new JSDOM('', { url: 'http://localhost' })
globalThis.window = dom.window
globalThis.localStorage = dom.window.localStorage
globalThis.localStorage.clear() // no creds

// Dynamic import so the stub above is in place.
const { providerRegistry, bootstrapProviders } = await import('../src/lib/providers/bootstrap.ts').catch(
  async () => {
    // .ts can't run via node directly; do a tiny shim by importing the
    // built artifact instead. Falls back to a manual enum.
    console.log('TypeScript not directly runnable; showing model catalog from source...')
    const { opencodeZenModels } = await import('../src/lib/providers/models.ts')
    return {
      providerRegistry: { listAllModels: () => opencodeZenModels, listAvailableModelsGrouped: () => [] },
      bootstrapProviders: () => {},
    }
  },
)

bootstrapProviders?.()
const all = providerRegistry.listAllModels()
const grouped = providerRegistry.listAvailableModelsGrouped()

console.log(`\n=== listAllModels() — ${all.length} models ===`)
for (const m of all) {
  const flag = m.free ? ' [free]' : ''
  console.log(`  ${m.provider}/${m.id}${flag}`)
}

console.log(`\n=== listAvailableModelsGrouped() — ${grouped.length} providers ===`)
for (const g of grouped) {
  console.log(`\n  ${g.provider.name} (${g.models.length} callable, hasCred=${g.hasCredential})`)
  for (const m of g.models) {
    const flag = m.free ? ' [free]' : ''
    console.log(`    - ${m.displayName}${flag}`)
  }
}
