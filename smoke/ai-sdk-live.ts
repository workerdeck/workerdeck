/**
 * Manual smoke for the model-agnostic runner against a REAL provider.
 * Spends tokens — never part of `pnpm test`.
 *
 *   MOONSHOT_API_KEY=... pnpm smoke:live            # Kimi K3 (default)
 *   OPENAI_API_KEY=...   pnpm smoke:live openai
 *   ANTHROPIC_API_KEY=... pnpm smoke:live anthropic
 *   ... pnpm smoke:live <provider> <model-id>       # pin a specific model
 *
 * Runs the full loop the PRD describes: the model calls an execute-less
 * `eval_script`, the loop parks, the host executes it in the QuickJS sandbox
 * against a scoped VFS, and the result re-enters the loop by message-state
 * replay. This is what the fake-model unit tests cannot validate: real tool-call
 * payload shapes and provider event drift.
 */
import { tool } from 'ai'
import { z } from 'zod'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine } from '@workerdeck/sandbox'
import { AiSdkRunner, QuickJsExecutor } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'

type ProviderName = 'moonshot' | 'openai' | 'anthropic'

const indent = (text: string): string =>
  text
    .split('\n')
    .map((line) => '   │ ' + line)
    .join('\n')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

const providerName = (process.argv[2] ?? 'moonshot') as ProviderName
const provider = PROVIDERS[providerName]
if (!provider) {
  console.error(`Unknown provider '${providerName}'. Use one of: ${Object.keys(PROVIDERS).join(', ')}`)
  process.exit(1)
}
if (!process.env[provider.env]) {
  console.error(`\nMissing ${provider.env} in the environment.\n`)
  console.error(`  ${provider.env}=... pnpm smoke:live ${providerName}\n`)
  process.exit(1)
}
const modelId = process.argv[3] ?? provider.defaultModel

console.log(`\nProvider: ${providerName}   Model: ${modelId}`)
console.log('='.repeat(60))

const factory = (await provider.load()) as (id: string) => never
const engine = await loadEngine(variant)
const executor = new QuickJsExecutor({ engine })

// The document the model must actually read to answer correctly. The value is
// deliberately odd so a hallucinated answer is obvious.
const vfs = createVfs({
  '/leads/acme.txt': 'company: Acme Corp\nrevenue: 4173\nemployees: 12\n',
})

const runner = new AiSdkRunner({
  languageModel: factory(modelId),
  instructions:
    'You evaluate sales leads. Use the eval_script tool to compute answers from files in the ' +
    'sandbox VFS — never guess numbers. The sandbox exposes vfs.read(path), vfs.write(path, text), ' +
    'and vfs.list(dir). The value of the last expression in your script is returned to you.',
  tools: {
    eval_script: tool({
      description: 'Run a JavaScript snippet in a sandbox with access to the scratch filesystem via the vfs global.',
      inputSchema: z.object({ script: z.string().describe('JavaScript to evaluate') }),
    }),
  },
})

runner.subscribe((event: SessionEvent) => {
  if (event.type === 'assistant_message') {
    for (const block of event.message.content as Array<Record<string, unknown>>) {
      if (block.type === 'text') {
        console.log(`\n💬 ${String(block.text).trim()}`)
      }
      if (block.type === 'tool_use') {
        console.log(`\n🔧 tool call: ${String(block.name)}`)
        const input = block.input as { script?: string }
        if (input?.script) {
          console.log(indent(input.script.trim()))
        }
      }
    }
  }
  if (event.type === 'turn_result') {
    console.log(
      `\n🏁 turn_result: ${event.subtype} (${event.durationMs}ms, turn ${event.numTurns})` +
        (event.usage ? `  usage: ${JSON.stringify(event.usage)}` : ''),
    )
    if (event.errors?.length) {
      console.log('   errors:', event.errors.join('; '))
    }
  }
  if (event.type === 'session_error') {
    console.error('\n❗ session_error:', event.message)
  }
})

void runner.start()
runner.sendMessage('Read /leads/acme.txt and tell me the revenue per employee, rounded to the nearest whole number.')

// Drive the park → execute → replay cycle until the turn completes.
const deadline = Date.now() + 120_000
let executions = 0
let completed = false
runner.subscribe((e) => {
  if (e.type === 'turn_result') {
    completed = true
  }
})

while (!completed && Date.now() < deadline) {
  const pending = runner.pendingToolCalls
  if (pending.length === 0) {
    await sleep(50)
    continue
  }
  for (const call of pending) {
    executions += 1
    console.log(`\n⚙️  executing ${call.toolName} in the sandbox (executionId ${call.toolCallId})`)
    const dispatch = await executor.dispatch({
      executionId: call.toolCallId,
      sessionId: runner.id,
      tool: call.toolName,
      input: call.input,
      vfs,
      limits: { timeoutMs: 5000 },
    })
    if (dispatch.status !== 'settled') {
      console.log('   dispatch is pending (deferred backend) — not expected for QuickJS')
      continue
    }
    const result = dispatch.result
    if (result.status === 'ok') {
      console.log(`   ✅ sandbox returned: ${JSON.stringify(result.output)}`)
      for (const log of result.logs ?? []) {
        console.log(`   guest ${log}`)
      }
      runner.resolveToolCall(call.toolCallId, { type: 'json', value: result.output })
    } else {
      console.log(`   ⚠️  sandbox failed (${result.reason}): ${result.error}`)
      // Feed the failure back so the model can adapt — this path is worth seeing.
      runner.resolveToolCall(call.toolCallId, { type: 'text', value: `${result.reason}: ${result.error}` }, { isError: true })
    }
  }
}

console.log('\n' + '='.repeat(60))
if (!completed) {
  console.error('\n❌ Timed out before the turn completed.\n')
  process.exit(1)
}

const info = runner.info()
console.log(`\nSession ${info.id}`)
console.log(`  status: ${info.status}   turns: ${info.numTurns}   events: ${info.lastSeq}`)
console.log(`  sandbox executions: ${executions}`)
console.log(`  VFS after the run: ${JSON.stringify(vfs.snapshot())}`)

// 4173 / 12 = 347.75 -> 348. The model must have run code to know this.
console.log('\nExpected answer: 348 (4173 / 12, rounded)')
if (executions === 0) {
  console.error('\n⚠️  The model answered WITHOUT calling the tool — the loop was never exercised.\n')
  process.exit(1)
}
console.log('\n✅ Live loop exercised: park → sandbox execute → message-state replay → completion.\n')
runner.close('server')
