/**
 * Tests for electron/shared/agent-config-schema.ts
 */

import { describe, expect, it } from 'vitest'
import {
  validateConfig,
  resolvePermission,
  resolveCommandPermission,
  BUILTIN_PROFILES,
  DEFAULT_AGENT_CONFIG,
  CONFIG_SCHEMA_ID,
  type AgentConfig,
} from '../../electron/shared/agent-config-schema'

// ── Schema validation ────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(validateConfig({})).toHaveLength(0)
  })

  it('accepts the default agent config', () => {
    expect(validateConfig(DEFAULT_AGENT_CONFIG)).toHaveLength(0)
  })

  it('accepts all permission profile names', () => {
    for (const profile of ['read_only', 'workspace_write', 'full_access'] as const) {
      expect(validateConfig({ permissionProfile: profile })).toHaveLength(0)
    }
  })

  it('rejects an unknown permission profile', () => {
    const errors = validateConfig({ permissionProfile: 'super_admin' })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects unknown top-level keys', () => {
    // Ajv reports additionalProperties errors at the root level with an empty
    // instanceLoc — just verify there is at least one error.
    const errors = validateConfig({ foo: 'bar', permissionProfile: 'workspace_write' })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects mcpServers with missing required fields', () => {
    // Ajv reports missing required field errors with the field name at the nested level.
    const errors = validateConfig({
      mcpServers: {
        'user:test': { id: 'user:test' }, // missing transport and command
      },
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('accepts a well-formed mcp server', () => {
    expect(
      validateConfig({
        mcpServers: {
          'user:filesystem': {
            id: 'user:filesystem',
            transport: 'stdio',
            command: '/usr/local/bin/mcp-server',
            args: ['--arg1', 'value'],
          },
        },
      }),
    ).toHaveLength(0)
  })

  it('rejects maxSubagentDepth > 5', () => {
    const errors = validateConfig({ maxSubagentDepth: 10 })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects negative maxSubagentTokens', () => {
    const errors = validateConfig({ maxSubagentTokens: -1 })
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ── Built-in profiles ───────────────────────────────────────────────────────

describe('BUILTIN_PROFILES', () => {
  it('has all three profile names', () => {
    expect(BUILTIN_PROFILES).toHaveProperty('read_only')
    expect(BUILTIN_PROFILES).toHaveProperty('workspace_write')
    expect(BUILTIN_PROFILES).toHaveProperty('full_access')
  })

  it('read_only denies all mutation tools', () => {
    const p = BUILTIN_PROFILES.read_only
    expect(p.edit?.['*']).toBe('deny')
    expect(p.bash?.['*']).toBe('deny')
    expect(p.webfetch?.['*']).toBe('deny')
  })

  it('read_only allows safe tools', () => {
    const p = BUILTIN_PROFILES.read_only
    expect(p.read?.['*']).toBe('allow')
    expect(p.skill?.['*']).toBe('allow')
    expect(p.lsp?.['*']).toBe('allow')
  })

  it('workspace_write asks on mutations', () => {
    const p = BUILTIN_PROFILES.workspace_write
    expect(p.edit?.['*']).toBe('ask')
    expect(p.bash?.['*']).toBe('ask')
    expect(p.webfetch?.['*']).toBe('ask')
  })

  it('full_access allows everything', () => {
    const p = BUILTIN_PROFILES.full_access
    for (const key of Object.keys(p) as (keyof typeof p)[]) {
      expect(p[key]?.['*']).toBe('allow')
    }
  })

  it('read_only and workspace_write ask doom_loop', () => {
    // full_access trusts the environment — doom_loop detection is not needed.
    expect(BUILTIN_PROFILES.read_only.doom_loop?.['*']).toBe('ask')
    expect(BUILTIN_PROFILES.workspace_write.doom_loop?.['*']).toBe('ask')
    expect(BUILTIN_PROFILES.full_access.doom_loop?.['*']).toBe('allow')
  })
})

// ── resolvePermission ────────────────────────────────────────────────────────

describe('resolvePermission', () => {
  const profiles = BUILTIN_PROFILES

  it('returns deny as safe default when no layers match', () => {
    const result = resolvePermission('read', 'some/path', [])
    expect(result).toBe('deny')
  })

  it('uses workspace_write profile by default (layers order)', () => {
    // Single layer = the profile itself
    const result = resolvePermission('read', 'src/index.ts', [profiles.workspace_write])
    expect(result).toBe('allow')
  })

  it('denies .env files regardless of profile', () => {
    // Even full_access should deny .env
    const result = resolvePermission('read', '.env', [profiles.full_access])
    expect(result).toBe('deny')
  })

  it('denies .env.local regardless of profile', () => {
    const result = resolvePermission('read', 'config/.env.local', [profiles.full_access])
    expect(result).toBe('deny')
  })

  it('denies credential files regardless of profile', () => {
    expect(resolvePermission('read', '~/.ssh/id_rsa', [profiles.full_access])).toBe(
      'deny',
    )
    expect(resolvePermission('read', '/secrets/api-key', [profiles.full_access])).toBe(
      'deny',
    )
  })

  it('allows .env.example (explicit exception)', () => {
    // The pattern *.env.example is not defined in defaults — this tests
    // that the schema supports it even if the default doesn't include it.
    const custom = {
      workspace_write: {
        ...profiles.workspace_write,
        read: { ...profiles.workspace_write.read, '*.env.example': 'allow' as const },
      },
    }
    const result = resolvePermission(
      'read',
      'config/.env.example',
      [custom.workspace_write],
    )
    expect(result).toBe('allow')
  })

  it('later layers override earlier layers', () => {
    const lower = { read: { '*': 'deny' } }
    const higher = { read: { '*': 'allow' } }
    const result = resolvePermission('read', 'any/file.txt', [lower, higher])
    expect(result).toBe('allow')
  })

  it('specific pattern wins over wildcard in same layer', () => {
    const layer = {
      read: {
        '*': 'deny' as const,
        'src/**': 'allow' as const,
      },
    }
    expect(resolvePermission('read', 'src/index.ts', [layer])).toBe('allow')
    expect(resolvePermission('read', 'docs/readme.md', [layer])).toBe('deny')
  })

  it('glob pattern ** matches any path', () => {
    const layer = { bash: { '**': 'allow' as const } }
    expect(resolveCommandPermission('git status', [layer])).toBe('allow')
    expect(resolveCommandPermission('rm -rf /', [layer])).toBe('allow')
  })

  it('glob pattern git * allows git commands with args', () => {
    // Mirrors OpenCode: "git *" should allow "git commit -m foo"
    const layer = { bash: { 'git *': 'allow' as const } }
    expect(resolveCommandPermission('git status', [layer])).toBe('allow')
    expect(resolveCommandPermission('git commit -m "fix"', [layer])).toBe('allow')
  })

  it('git * prefix pattern can be narrowed by more specific patterns', () => {
    // Mirrors OpenCode: deny git push, allow git status/commit
    const layer = {
      bash: {
        'git *': 'allow' as const,
        'git push': 'deny' as const,    // exact override
        'git commit': 'deny' as const,  // exact override
      },
    }
    expect(resolveCommandPermission('git status', [layer])).toBe('allow')
    expect(resolveCommandPermission('git commit', [layer])).toBe('deny')
    expect(resolveCommandPermission('git push', [layer])).toBe('deny')
  })

  it('webfetch URL pattern matching', () => {
    const layer = {
      webfetch: {
        'https://api.example.com/**': 'allow' as const,
        '*': 'deny' as const,
      },
    }
    expect(
      resolvePermission('webfetch', 'https://api.example.com/v1/users', [layer]),
    ).toBe('allow')
    expect(resolvePermission('webfetch', 'https://evil.com/steal', [layer])).toBe(
      'deny',
    )
  })
})

// ── DEFAULT_AGENT_CONFIG ────────────────────────────────────────────────────

describe('DEFAULT_AGENT_CONFIG', () => {
  it('uses workspace_write as the default profile', () => {
    expect(DEFAULT_AGENT_CONFIG.permissionProfile).toBe('workspace_write')
  })

  it('is a valid config', () => {
    expect(validateConfig(DEFAULT_AGENT_CONFIG)).toHaveLength(0)
  })
})
