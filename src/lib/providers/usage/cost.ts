import {
  openaiModels,
  anthropicModels,
  opencodeZenModels,
  opencodeGoModels,
  geminiModels,
  antigravityModels,
} from '../models'

const ALL_CATALOGS = [
  ...openaiModels,
  ...anthropicModels,
  ...opencodeZenModels,
  ...opencodeGoModels,
  ...geminiModels,
  ...antigravityModels,
]

const pricingMap = new Map<string, { input: number; output: number }>()
for (const m of ALL_CATALOGS) {
  if (m.inputCost !== undefined || m.outputCost !== undefined) {
    if (!pricingMap.has(m.id)) {
      pricingMap.set(m.id, {
        input: m.inputCost ?? 0,
        output: m.outputCost ?? 0,
      })
    }
  }
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = pricingMap.get(model)
  if (!pricing) return 0
  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  return Math.round(cost * 1_000_000) / 1_000_000
}
