import { describe, expect, it } from 'vitest'
import { ENGINE_CAPABILITIES, supportsPermissionMode, type PermissionMode, type ProfileEngine } from '@workerdeck/protocol'
import { claudeAdapter } from '../src/engines/claude/adapter.ts'
import { codexAdapter } from '../src/engines/codex/adapter.ts'
import { providerAdapter } from '../src/engines/provider/adapter.ts'
import { getEngineAdapter } from '../src/engines/adapter.ts'
import { CLAUDE_CATALOG } from '../src/engines/claude/catalog.ts'
import { CODEX_CATALOG } from '../src/engines/codex/catalog.ts'
import { modelOptionsFromSdk, type SdkModelInfo } from '../src/lib/normalize.ts'

const ENGINES = Object.keys(ENGINE_CAPABILITIES) as ProfileEngine[]
const ALL_MODES: PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']

describe('ENGINE_CAPABILITIES invariants', () => {
  it('keeps defaultPermissionMode inside permissionModes for every engine', () => {
    for (const engine of ENGINES) {
      const caps = ENGINE_CAPABILITIES[engine]
      expect(caps.permissionModes).toContain(caps.defaultPermissionMode)
    }
  })

  it('answers supportsPermissionMode exactly as before for claude and provider', () => {
    for (const mode of ALL_MODES) {
      expect(supportsPermissionMode('claude', mode)).toBe(true)
      expect(supportsPermissionMode(undefined, mode)).toBe(true)
      expect(supportsPermissionMode('provider', mode)).toBe(
        (['default', 'bypassPermissions', 'dontAsk'] as PermissionMode[]).includes(mode),
      )
    }
  })

  it('declares the codex quartet and nothing else', () => {
    for (const mode of ALL_MODES) {
      expect(supportsPermissionMode('codex', mode)).toBe(
        (['default', 'acceptEdits', 'bypassPermissions', 'auto'] as PermissionMode[]).includes(mode),
      )
    }
  })

  it('declares hostCwd for the engines that spawn a binary, and against the one that does not', () => {
    expect(ENGINE_CAPABILITIES.claude.hostCwd).toBe(true)
    expect(ENGINE_CAPABILITIES.codex.hostCwd).toBe(true)
    expect(ENGINE_CAPABILITIES.provider.hostCwd).toBe(false)
    for (const engine of ENGINES) {
      expect(ENGINE_CAPABILITIES[engine].hostCwd).toBeDefined()
    }
  })

  it('declares approvals for claude and codex, and token streaming for codex', () => {
    expect(ENGINE_CAPABILITIES.claude.interactiveApprovals).toBe(true)
    expect(ENGINE_CAPABILITIES.codex.streaming).toBe('token')
    expect(ENGINE_CAPABILITIES.codex.interactiveApprovals).toBe(true)
    expect(ENGINE_CAPABILITIES.provider.interactiveApprovals).toBe(false)
  })
})

describe('adapter conformance', () => {
  it('every adapter’s record IS the protocol record — the divergence guard', () => {
    // Identity, not equality: adapters must reference the protocol constant, never copy it.
    expect(claudeAdapter.capabilities).toBe(ENGINE_CAPABILITIES.claude)
    expect(codexAdapter.capabilities).toBe(ENGINE_CAPABILITIES.codex)
    expect(providerAdapter.capabilities).toBe(ENGINE_CAPABILITIES.provider)
  })

  it('routes getEngineAdapter by engine, defaulting to claude', () => {
    expect(getEngineAdapter('claude')).toBe(claudeAdapter)
    expect(getEngineAdapter('codex')).toBe(codexAdapter)
    expect(getEngineAdapter('provider')).toBe(providerAdapter)
    expect(getEngineAdapter(undefined)).toBe(claudeAdapter)
  })

  it('refuses restore on the engines that cannot rehydrate', async () => {
    expect(() =>
      claudeAdapter.createRunner({
        config: { cwd: '/tmp' },
        restore: { engine: 'claude', id: 'x', createdAt: 0, seq: 0, events: [], parked: [], state: {} },
      }),
    ).toThrow(/cannot rebuild a parked session/)
    await expect(
      (async () =>
        codexAdapter.createRunner({
          config: { cwd: '/tmp' },
          restore: { engine: 'codex', id: 'x', createdAt: 0, seq: 0, events: [], parked: [], state: {} },
        }))(),
    ).rejects.toThrow(/cannot rebuild a parked session/)
  })
})

describe('model catalogs', () => {
  it('never ship a default sentinel row', () => {
    for (const catalog of [CLAUDE_CATALOG, CODEX_CATALOG]) {
      expect(catalog.models.some((m) => m.value === 'default')).toBe(false)
      expect(catalog.provenance.length).toBeGreaterThan(0)
    }
  })

  // The raw `supportedModels()` extraction the claude catalog was authored from (2026-08-05,
  // SDK 0.3.221), replayed through the live shaping rules.
  const RAW_CLAUDE: SdkModelInfo[] = [
    {
      value: 'default',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Opus (1M context)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'claude-fable-5[1m]',
      resolvedModel: 'claude-fable-5',
      displayName: 'Fable',
      description: 'Fable 5 · Most capable for your hardest and longest-running tasks',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet',
      description: 'Sonnet 5 · Efficient for routine tasks',
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku',
      description: 'Haiku 4.5 · Fastest for quick answers',
      supportsEffort: false,
    },
  ]

  it('claude catalog current rows match the live shaping of their extraction', () => {
    const shaped = modelOptionsFromSdk(RAW_CLAUDE)
    const currentRows = CLAUDE_CATALOG.models.filter((m) => RAW_CLAUDE.some((raw) => raw.value === m.value))
    expect(currentRows).toEqual(shaped)
  })

  it('claude catalog marks exactly one primary row per family', () => {
    const primaries = CLAUDE_CATALOG.models.filter((m) => m.primary)
    expect(primaries.map((m) => m.displayName)).toEqual(['Fable 5', 'Opus 5', 'Sonnet 5', 'Haiku 4.5'])
  })

  it('codex catalog drops the internal auto-review row and keeps efforts open', () => {
    expect(CODEX_CATALOG.models.some((m) => m.value === 'codex-auto-review')).toBe(false)
    for (const model of CODEX_CATALOG.models) {
      expect(model.reasoningEfforts?.length).toBeGreaterThan(0)
    }
    expect(CODEX_CATALOG.models[0]!.reasoningEfforts).toContain('ultra')
  })

  it('codex catalog primary split mirrors the binary’s own picker visibility', () => {
    const primary = CODEX_CATALOG.models.filter((m) => m.primary).map((m) => m.value)
    expect(primary).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'])
  })

  it('provider pseudo-adapter ships an empty catalog and a hook-refusing factory', () => {
    expect(providerAdapter.catalog.models).toEqual([])
    expect(() => providerAdapter.createRunner({ config: { cwd: '/tmp' } })).toThrow(/createEngineRunner/)
  })
})

describe('provider availability probe', () => {
  it('answers from the named env var alone, unknown without a declaration', async () => {
    const profile = { name: 'kimi', engine: 'provider' as const, provider: { id: 'moonshotai', apiKeyEnv: 'MOONSHOT_API_KEY' } }
    expect(await providerAdapter.checkAvailability(profile, { MOONSHOT_API_KEY: 'x' })).toEqual({
      available: true,
    })
    expect(await providerAdapter.checkAvailability(profile, {})).toMatchObject({
      available: false,
    })
    expect(await providerAdapter.checkAvailability({ name: 'p', engine: 'provider', provider: { id: 'x' } }, {})).toEqual({
      available: 'unknown',
    })
  })
})
