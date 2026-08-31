// pnpm smoke:mcp --probe                  # connect + list tools against the real DeepWiki server, no model, FREE
// pnpm smoke:mcp [provider] [model-id]    # the same tools granted to a real session — costs tokens
//
// The only place a real streamable-http MCP connection is exercised end to end: tools arrive namespaced, stay
// authoritative (server-side execute, never bridged), and the turn completes on their output.
import type { LanguageModel } from 'ai'
import type { SessionEvent, ToolUseBlock } from '@workerdeck/protocol'
import { connectMcpTools, createEngineSession, type ToolExecutor } from '@workerdeck/core'

const DEEPWIKI_URL = 'https://mcp.deepwiki.com/mcp'

const args = process.argv.slice(2).filter((a) => a !== '--probe')
const probeOnly = process.argv.includes('--probe')

console.log(`\nConnecting to DeepWiki MCP (${DEEPWIKI_URL}) ...`)
const mcp = await connectMcpTools(
  { deepwiki: { type: 'http', url: DEEPWIKI_URL } },
  { onError: (name, error) => console.error(`  MCP '${name}' error: ${String(error)}`) },
)
const toolNames = Object.keys(mcp.tools)
console.log(`Tools: ${toolNames.join(', ') || '(none)'}`)

if (toolNames.length === 0) {
  console.error('\n❌ DeepWiki exposed no tools — server unreachable or protocol drift.\n')
  process.exit(1)
}
if (!toolNames.some((name) => name.startsWith('deepwiki__'))) {
  console.error('\n❌ Tools are not namespaced by server name.\n')
  process.exit(1)
}
if (probeOnly) {
  await mcp.close()
  console.log('\n✅ Probe passed: live connection, namespaced tools, clean close.\n')
  process.exit(0)
}

type ProviderName = 'moonshot' | 'openai' | 'anthropic'
const PROVIDERS: Record<ProviderName, { env: string; defaultModel: string; load: () => Promise<unknown> }> = {
  moonshot: {
    env: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k3',
    load: () => import('@ai-sdk/moonshotai').then((m) => m.moonshotai),
  },
  openai: {
    env: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    load: () => import('@ai-sdk/openai').then((m) => m.openai),
  },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5',
    load: () => import('@ai-sdk/anthropic').then((m) => m.anthropic),
  },
}

const providerName = (args[0] ?? 'moonshot') as ProviderName
const provider = PROVIDERS[providerName]
if (!provider) {
  console.error(`Unknown provider '${providerName}'. Use one of: ${Object.keys(PROVIDERS).join(', ')}`)
  process.exit(1)
}
if (!process.env[provider.env]) {
  console.error(`\nMissing ${provider.env} in the environment.\n`)
  console.error(`  ${provider.env}=... pnpm smoke:mcp ${providerName}\n`)
  process.exit(1)
}
const modelId = args[1] ?? provider.defaultModel
const factory = (await provider.load()) as (id: string) => LanguageModel
const model = factory(modelId)

console.log(`\nProvider: ${providerName}   Model: ${modelId}`)
console.log('='.repeat(60))

// No sandboxed executions expected here; a stub keeps the wiring honest.
const noExecutor: ToolExecutor = {
  dispatch: async (call) => ({
    executionId: call.executionId,
    status: 'settled',
    result: { status: 'failed', reason: 'unsupported_tool', error: 'no sandbox in this smoke' },
  }),
}

const runner = createEngineSession({
  config: { cwd: '/tmp', languageModel: model, onClose: () => void mcp.close() },
  resolveModel: () => model,
  selectExecutor: () => noExecutor,
  mcpTools: mcp.tools,
  instructions:
    'Answer questions about public GitHub repositories using the deepwiki tools. ' +
    'Never answer from memory — always consult the tools first.',
})

const events: SessionEvent[] = []
let completed = false
runner.subscribe((event) => {
  events.push(event)
  if (event.type === 'assistant_message' && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'text') {
        console.log(`\n💬 ${String((block as { text: string }).text).trim()}`)
      }
      if (block.type === 'tool_use') {
        console.log(`\n🔧 tool call: ${(block as ToolUseBlock).name}`)
      }
    }
  }
  if (event.type === 'turn_result') {
    completed = true
    console.log(`\n🏁 turn_result: ${event.subtype} (${event.durationMs}ms)`)
    if (event.errors?.length) {
      console.log('   errors:', event.errors.join('; '))
    }
  }
})

void runner.start()
runner.sendMessage(
  'What does the wiki for the facebook/react repository say about how hooks are implemented? ' +
    'Use the deepwiki tools and answer in two sentences based on what they return.',
)

const deadline = Date.now() + 180_000
while (!completed && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100))
}

console.log('\n' + '='.repeat(60))
const fail = (message: string): never => {
  console.error(`\n❌ ${message}\n`)
  process.exit(1)
}

if (!completed) {
  fail('Timed out before the turn completed.')
}
const turn = events.find((e) => e.type === 'turn_result')!
if (turn.type === 'turn_result' && turn.subtype !== 'success') {
  fail(`Turn ended with '${turn.subtype}', not success.`)
}

const mcpCalls = events.flatMap((e) =>
  e.type === 'assistant_message' && Array.isArray(e.message.content)
    ? e.message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use' && String(b.name).startsWith('deepwiki__'))
    : [],
)
if (mcpCalls.length === 0) {
  fail('The model answered WITHOUT calling a deepwiki__* tool — live MCP was never exercised.')
}

runner.close()
console.log(`\n  deepwiki tool calls: ${mcpCalls.length} (${[...new Set(mcpCalls.map((c) => c.name))].join(', ')})`)
console.log('\n✅ Live MCP exercised: remote connect → namespaced authoritative tools → turn completed on their output.\n')
process.exit(0)
