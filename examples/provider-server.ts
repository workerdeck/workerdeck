/**
 * The `'provider'`-engine example: how a HOST wires the model-agnostic engine
 * through the `createEngineRunner` hook. This is the escape hatch for engines
 * the repo does not ship as adapters — the `@ai-sdk` providers below (openai,
 * moonshotai, anthropic-over-API) are not offered by default anywhere any
 * more, but this example keeps the path compiling and runnable, and it is the
 * route back if they return as bespoke adapters. Claude and codex profiles
 * need none of this: their adapters ship in `@workerdeck/core`.
 *
 * Drop-in replacement for `pnpm dev:server` (same port, NO AUTH, loopback only). Unlike
 * `pnpm dev:server` this is a bare gateway, not the CLI, so it serves no dashboard —
 * pair it with `pnpm dev:web`:
 *
 *   pnpm example:server        # reads .env for provider keys (see below)
 *   pnpm dev:web                   # then open http://localhost:5191
 *
 * Declares one Claude profile (the operator's own ~/.claude) plus a provider
 * profile per API key found in the environment / repo .env:
 *
 *   ANTHROPIC_API_KEY → profile 'anthropic' (claude-sonnet-5)
 *   OPENAI_API_KEY    → profile 'openai'    (gpt-5)
 *   MOONSHOT_API_KEY  → profile 'moonshot'  (kimi-k3)
 *
 * Profiles can also be created and edited from the dashboard's Profiles view:
 * this server wires a file-backed profile store at
 * `.workerdeck/profiles.json` and marks every caller as able to manage them.
 *
 * Provider sessions get the capability-scoped tool set with a scratch VFS
 * seeded with a demo document, and `eval_script` executes IN YOUR BROWSER TAB:
 * the server has no sandbox executor here, so every eval crosses the WS bridge
 * to the attached dashboard, which runs it in a QuickJS guest and answers.
 */
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
  /** Extra model ids the dashboard's picker offers for this profile. Operator-
   * declared: provider engines have no equivalent of the CLI's supportedModels().
   * Left unset here for the others, so the picker's default-only fallback shows too. */
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

// One model factory per provider that actually has a key.
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

// Live MCP: one shared connection for the whole process (sessions must NOT close
// it — it outlives them; it dies with the process). `createEngineRunner` may be
// async, so a per-session connect is possible (dispose via
// `AiSdkRunnerConfig.onClose`) — shared is simply the right call for a dev server
// hitting one public endpoint. DeepWiki is free/no-auth and answers questions
// about public GitHub repos. Unreachable = sessions simply don't get the tools;
// the dev server still starts.
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
    // What sessions under this profile get. The runner factory below wires the
    // backends; this decides which of them are granted, so withholding one is a
    // profile edit rather than a code change. MCP is named, never configured
    // here — the transport config (and any credentials in it) stays server-side.
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
  // Loopback dev server: accept every caller, and let them manage profiles so the
  // Profiles view is exercisable end to end. A real deployment derives
  // `canManageProfiles` from its own identity system — see docs/guides/profiles.
  authenticate: () => ({ canManageProfiles: true }),
  profiles,
  // Managed profiles persist next to the repo, so one survives a restart.
  profileStore: createFileProfileStore(join(process.cwd(), '.workerdeck', 'profiles.json')),
  // A managed Claude profile may point anywhere under your home directory here;
  // a real deployment scopes this much more tightly.
  allowedConfigDirRoots: [homedir()],
  createEngineRunner: ({ config, profile, bridge, restore }) => {
    // Profiles created from the dashboard can name any provider; this example
    // only built factories for the keys that were present at startup. Say which
    // key is missing — the rejection surfaces as the create's 500 body (and as a
    // job's failure reason), so a bare TypeError here would be all the operator
    // ever sees.
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
    // A document the model can only reason about by running code over it. On a
    // rehydrated session the snapshot's filesystem wins — seeding here would
    // undo whatever the parked turn already wrote.
    const vfs = restore
      ? undefined
      : createVfs({
          '/leads/acme.txt': 'company: Acme Corp\nrevenue: 4173\nemployees: 12\n',
        })
    // The runner's id does not exist yet at assembly time, so resolve the
    // session's bridge executor at dispatch time from the call's own sessionId.
    const toBrowser: ToolExecutor = {
      dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
    }
    // No permission-mode coercion here: the create form only offers what this
    // engine runs, and the gateway rejects the CLI-only modes with a 400.
    return createEngineSession({
      // `restore` is what makes a parked session come back as itself: same id,
      // same event log, same history, mid-task.
      config: { ...config, languageModel: factory(modelId), vfs, restore },
      profile,
      resolveModel: (_profile, c) => factory(c.model ?? modelId),
      selectExecutor: () => toBrowser,
      backend: 'browser',
      // Backends, not grants: web_fetch with defaults (SSRF-guarded fetch +
      // HTML→markdown, digested by the session's own model and billed into the
      // turn), and every connected MCP tool. The profile's `session` block above
      // decides which of these a session actually gets.
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
