import { describe, expect, it } from 'vitest'
import { getSkillSourceStyle } from '../src/components/skills/skill-source-style'

describe('getSkillSourceStyle', () => {
  it('falls back for future skill sources', () => {
    const fallback = getSkillSourceStyle('future-provider')
    expect(fallback).toBe(getSkillSourceStyle('agents'))
    expect(fallback.icon).toBeDefined()
    expect(fallback.badge).toContain('purple')
  })
})
