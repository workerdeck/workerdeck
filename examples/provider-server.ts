import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import type { ProfileInfo } from '@workerdeck/protocol'
import { createVfs } from '@workerdeck/sandbox'
import { connectMcpTools, createEngineSession, type ToolExecutor } from '@workerdeck/core'
import { createFileProfileStore, createWorkerServer } from '@workerdeck/server'

type ProviderSetup = {
  env: string
  model: string
  models?: string[]
  load: () => Promise<unknown>
}

const PROVIDERS: Record<string, ProviderSetup> = {
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5',
    models: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    load: () => import('@ai-sdk/anthropic').then((m) => m.anthropic),
  },
  openai: {
    env: 'OPENAI_API_KEY',
    model: 'gpt-5',
    load: () => import('@ai-sdk/openai').then((m) => m.openai),
  },
  moonshot: {
    env: 'MOONSHOT_API_KEY',
    model: 'kimi-k3',
    load: () => import('@ai-sdk/moonshotai').then((m) => m.moonshotai),
  },
}

const factories = new Map<string, (id: string) => LanguageModel>()
const profiles: ProfileInfo[] = []

const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
if (existsSync(claudeConfigDir)) {
  profiles.push({
    name: 'claude',
    configDir: claudeConfigDir,
    description: 'Claude Code via the Agent SDK (your own config dir)',
  })
}

// One shared connection for the whole process: a session must NOT close it, unlike the per-session connect `onClose` disposes.
const mcp = await connectMcpTools(process.env.NO_MCP ? {} : { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } }, {
  onError: (name, error) => console.warn(`[provider-example] MCP '${name}' unavailable: ${String(error)}`),
})
const mcpToolNames = Object.keys(mcp.tools)

const INSTRUCTIONS =
  'You evaluate sales leads. Use the eval_script tool to compute answers from files in the ' +
  'scratch filesystem — never guess numbers. Inside eval_script the sandbox exposes ' +
  'vfs.read(path), vfs.write(path, text), and vfs.list(dir); the value of the last ' +
  'expression is returned to you. Use web_fetch to answer questions about a web page. ' +
  'To hand a file to the user, write it with fs_write, then call deliver_file — the user ' +
  'gets a download card.' +
  (mcpToolNames.length > 0 ? ` For questions about public GitHub repositories, use the ${mcpToolNames.join(', ')} tools.` : '')

for (const [name, setup] of Object.entries(PROVIDERS)) {
  if (!process.env[setup.env]) {
    continue
  }
  factories.set(name, (await setup.load()) as (id: string) => LanguageModel)
  profiles.push({
    name,
    engine: 'provider',
    provider: { id: name, model: setup.model, models: setup.models, apiKeyEnv: setup.env },
    description: `Model-agnostic engine (${setup.model}); eval_script runs in your browser tab`,
    session: {
      capabilities: ['web_fetch', 'deliver_file'],
      mcpServers: ['deepwiki'],
      instructions: INSTRUCTIONS,
    },
  })
}

if (profiles.length === 0) {
  console.error('No ~/.claude config dir and no provider API keys found — nothing to serve.')
  process.exit(1)
}

const { listen } = createWorkerServer({
  authenticate: () => ({ canManageProfiles: true }),
  profiles,
  profileStore: createFileProfileStore(join(process.cwd(), '.workerdeck', 'profiles.json')),
  allowedConfigDirRoots: [homedir()],
  createEngineRunner: ({ config, profile, bridge, restore }) => {
    const providerId = profile.provider!.id
    const factory = factories.get(providerId)
    if (!factory) {
      const known = Object.keys(PROVIDERS)
      throw new Error(
        known.includes(providerId)
          ? `profile '${profile.name}' needs ${PROVIDERS[providerId]!.env} in the environment ` +
              '(or the repo .env) — this dev server started without it, so it has no model factory ' +
              `for '${providerId}'. Add the key and restart.`
          : `profile '${profile.name}' names provider '${providerId}', which this example does not ` +
              `wire. Known here: ${known.join(', ')}.`,
      )
    }
    const modelId = config.model ?? profile.provider!.model
    if (!modelId) {
      throw new Error(
        `profile '${profile.name}' declares no provider.model and the request named none — ` +
          'set a model on the profile (or pass one when creating the session).',
      )
    }
    // On a rehydrated session the snapshot's filesystem wins — seeding here would undo what the parked turn wrote.
    const vfs = restore
      ? undefined
      : createVfs({
          '/leads/acme.txt': 'company: Acme Corp\nrevenue: 4173\nemployees: 12\n',
        })
    // The runner's id does not exist yet at assembly time, so the executor resolves the bridge per call instead.
    const toBrowser: ToolExecutor = {
      dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
    }
    return createEngineSession({
      config: { ...config, languageModel: factory(modelId), vfs, restore },
      profile,
      resolveModel: (_profile, c) => factory(c.model ?? modelId),
      selectExecutor: () => toBrowser,
      backend: 'browser',
      // Backends, not grants: the profile's `session` block above decides which of these a session gets.
      capabilities: { webFetch: {} },
      mcpTools: mcp.tools,
      executionLimits: { timeoutMs: 15_000 },
    })
  },
})

const port = Number(process.env.PORT ?? 8787)
const { port: boundPort } = await listen(port, '127.0.0.1')

console.log(`\n[provider-example] dev server (NO AUTH) on http://127.0.0.1:${boundPort}/v1`)
console.log('[provider-example] profiles:')
for (const p of profiles) {
  console.log(`  - ${p.name}${p.engine === 'provider' ? ` (provider: ${p.provider!.model})` : ' (claude)'}`)
}
const missing = Object.entries(PROVIDERS).filter(([, s]) => !process.env[s.env])
for (const [name, setup] of missing) {
  console.log(`[provider-example] no ${setup.env} — profile '${name}' not offered`)
}
console.log(
  mcpToolNames.length > 0
    ? `[provider-example] MCP tools: ${mcpToolNames.join(', ')}`
    : '[provider-example] no MCP tools (DeepWiki unreachable or NO_MCP set)',
)
console.log('\n[provider-example] next: `pnpm dev:web`, open http://localhost:5191, and follow examples/README.md')
