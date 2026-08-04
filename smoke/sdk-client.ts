/**
 * Manual smoke for the FULL consumer stack against a real provider:
 *
 *   real model → AiSdkRunner on a real createWorkerServer → HTTP/WS →
 *   WorkerDeckClient → createToolCallHost executing in a real QuickJS guest
 *
 * Spends tokens — never part of `pnpm test`.
 *
 *   MOONSHOT_API_KEY=...  pnpm smoke:sdk             # Kimi K3 (default)
 *   OPENAI_API_KEY=...    pnpm smoke:sdk openai
 *   ANTHROPIC_API_KEY=... pnpm smoke:sdk anthropic
 *   ... pnpm smoke:sdk <provider> <model-id>         # pin a specific model
 *
 * `smoke:live` drives the runner in-process; `bridge-e2e.test.ts` drives the
 * server+client with a stubbed model. This is the combination neither covers:
 * the model's eval_script calls travel over the wire to the CLIENT's sandbox
 * (the server has no QuickJS executor at all here), while the authoritative
 * fs_* tools run server-side — the trust split, live.
 */
import WebSocket from 'ws'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, type SandboxVfs } from '@workerdeck/sandbox'
import { createEngineSession, type ToolExecutor } from '@workerdeck/core'
import { createWorkerServer } from '@workerdeck/server'
import { WorkerDeckClient } from '@workerdeck/client'
import { createToolCallHost } from '@workerdeck/react'
import type { LanguageModel } from 'ai'
import type { SessionEvent } from '@workerdeck/protocol'

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

const providerName = (process.argv[2] ?? 'moonshot') as ProviderName
const provider = PROVIDERS[providerName]
if (!provider) {
  console.error(`Unknown provider '${providerName}'. Use one of: ${Object.keys(PROVIDERS).join(', ')}`)
  process.exit(1)
}
if (!process.env[provider.env]) {
  console.error(`\nMissing ${provider.env} in the environment.\n`)
  console.error(`  ${provider.env}=... pnpm smoke:sdk ${providerName}\n`)
  process.exit(1)
}
const modelId = process.argv[3] ?? provider.defaultModel

console.log(`\nProvider: ${providerName}   Model: ${modelId}`)
console.log('='.repeat(60))

const factory = (await provider.load()) as (id: string) => LanguageModel
const model = factory(modelId)
const engine = await loadEngine(variant)

// ---------------------------------------------------------------- server ----

/** Server-side scratch VFS per session, kept so we can inspect it afterwards. */
const serverVfs = new Map<string, SandboxVfs>()

const server = createWorkerServer({
  allowUnauthenticated: true,
  allowedCwdRoots: ['/tmp'],
  profiles: [
    {
      name: providerName,
      engine: 'provider',
      provider: { id: providerName, model: modelId, apiKeyEnv: provider.env },
    },
  ],
  bridge: { timeoutMs: 30_000 },
  // Bridged results flow back into the runner via the server itself: the hub's
  // onResult calls the adopted runner's settleExecution. Nothing to wire here.
  createEngineRunner: ({ config, profile, bridge, restore }) => {
    // A rehydrated session brings its own filesystem back in the snapshot.
    const vfs = restore
      ? createVfs(restore.vfs)
      : createVfs({
          '/leads/acme.txt': 'company: Acme Corp\nrevenue: 4173\nemployees: 12\n',
        })
    // The runner's id does not exist yet, so the executor is a delegate that
    // resolves the session's bridge executor at dispatch time — every dispatch
    // carries the runner's own id as `sessionId`.
    const toBrowser: ToolExecutor = {
      dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
    }
    const runner = createEngineSession({
      config: { ...config, languageModel: model, vfs, restore },
      profile,
      resolveModel: () => model,
      selectExecutor: () => toBrowser,
      backend: 'browser',
      instructions:
        'You evaluate sales leads. Use the eval_script tool to compute answers from files in the ' +
        'scratch filesystem — never guess numbers. Inside eval_script the sandbox exposes ' +
        'vfs.read(path), vfs.write(path, text), and vfs.list(dir); the value of the last ' +
        'expression is returned to you. To hand a file to the user, write it with fs_write, ' +
        'then call deliver_file with its path.',
      executionLimits: { timeoutMs: 15_000 },
    })
    serverVfs.set(runner.id, vfs)
    return runner
  },
})

const { port } = await server.listen(0, '127.0.0.1')
console.log(`\nServer listening on 127.0.0.1:${port}`)

// ---------------------------------------------------------------- client ----

const client = new WorkerDeckClient({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
})

const session = await client.createSession({
  cwd: '/tmp/workerdeck-smoke',
  profile: providerName,
})
console.log(`Session ${session.id} created over REST (profile '${session.profile}')`)

const handle = client.attach(session.id)
await new Promise<void>((resolve) => handle.on('attached', () => resolve()))
console.log('Attached over WS')

// The "browser" side: the real tool host from @workerdeck/react, running the
// real guest. Attached BEFORE the prompt — bridged dispatch fails fast otherwise.
const host = createToolCallHost(handle, { loadEngine: async () => engine })

let clientExecutions = 0
handle.on('toolCallRequest', (frame) => {
  clientExecutions += 1
  console.log(`\n📡 tool_call_request reached the CLIENT: ${frame.toolName} (${frame.executionId})`)
})

const events: SessionEvent[] = []
let completed = false
handle.on('event', (event) => {
  events.push(event)
  if (event.type === 'assistant_message') {
    for (const block of event.message.content as Array<Record<string, unknown>>) {
      if (block.type === 'text') console.log(`\n💬 ${String(block.text).trim()}`)
      if (block.type === 'tool_use') {
        console.log(`\n🔧 tool call: ${String(block.name)}`)
        const input = block.input as { script?: string }
        if (input?.script) console.log(indent(input.script.trim()))
      }
    }
  }
  if (event.type === 'execution_dispatched') {
    console.log(`\n⚙️  execution_dispatched → backend '${event.backend}' (${event.executionId})`)
  }
  if (event.type === 'execution_result') {
    console.log(`   ✅ execution_result: ${JSON.stringify(event.output.value)}`)
    for (const log of event.logs ?? []) console.log(`   guest ${log}`)
  }
  if (event.type === 'execution_failed') {
    console.log(`   ⚠️  execution_failed (${event.reason}): ${event.error}`)
  }
  if (event.type === 'turn_result') {
    completed = true
    console.log(
      `\n🏁 turn_result: ${event.subtype} (${event.durationMs}ms, turn ${event.numTurns})` +
        (event.usage ? `  usage: ${JSON.stringify(event.usage)}` : ''),
    )
    if (event.errors?.length) console.log('   errors:', event.errors.join('; '))
  }
  if (event.type === 'file_delivered') {
    console.log(`\n📦 file_delivered: ${event.path} (${event.bytes} bytes)`)
  }
  if (event.type === 'session_error') console.error('\n❗ session_error:', event.message)
})

handle.send(
  'Read /leads/acme.txt and tell me the revenue per employee, rounded to the nearest whole ' +
    'number. Compute it with eval_script. Then save {"revenuePerEmployee": <the number>} to ' +
    '/out/report.json using the fs_write tool and hand it to me with deliver_file.',
)

const deadline = Date.now() + 180_000
while (!completed && Date.now() < deadline) await sleep(100)

// ---------------------------------------------------------------- verdict ----

console.log('\n' + '='.repeat(60))

const fail = (message: string): never => {
  console.error(`\n❌ ${message}\n`)
  process.exit(1)
}

if (!completed) fail('Timed out before the turn completed.')

const turn = events.find((e) => e.type === 'turn_result')!
if (turn.type === 'turn_result' && turn.subtype !== 'success') {
  fail(`Turn ended with '${turn.subtype}', not success.`)
}

// The model must have gone through the sandbox — and through the CLIENT's, since
// this server has no QuickJS executor of its own.
if (clientExecutions === 0) {
  fail('The model answered WITHOUT a bridged execution — the client sandbox was never exercised.')
}
const dispatched = events.filter((e) => e.type === 'execution_dispatched')
const wrongBackend = dispatched.filter((e) => e.type === 'execution_dispatched' && e.backend !== 'browser')
if (wrongBackend.length > 0) {
  fail(`Some executions did not go to the browser backend: ${JSON.stringify(wrongBackend)}`)
}

// 4173 / 12 = 347.75 → 348. Only computable by running code over the document.
const finalText = turn.type === 'turn_result' ? (turn.result ?? '') : ''
if (!finalText.includes('348')) {
  fail(`The final answer does not contain 348 — got: ${finalText}`)
}

// Usage must cover every leg of the parked turn.
const usage =
  turn.type === 'turn_result'
    ? (turn.usage as { input_tokens?: number; output_tokens?: number } | undefined)
    : undefined
if (!usage || (usage.input_tokens ?? 0) === 0 || (usage.output_tokens ?? 0) === 0) {
  fail(`turn_result usage is empty: ${JSON.stringify(usage)}`)
}

// The trust split: fs_write is authoritative and runs on the SERVER's vfs. The
// bridged guest only ever sees a snapshot, so this file existing server-side
// proves the split worked. Providers vary in following the instruction, so
// this is a warning rather than a failure.
const vfs = serverVfs.get(session.id)!
const report = vfs.read('/out/report.json')
if (report?.includes('348')) {
  console.log(`\n✅ Server-side fs_write landed: /out/report.json = ${report.trim()}`)
} else {
  console.log(
    `\n⚠️  /out/report.json not found on the server VFS (model skipped fs_write). ` +
      `VFS: ${JSON.stringify(vfs.snapshot())}`,
  )
}

// File delivery, end to end: the deliver_file tool emitted file_delivered over
// the WS, and the file is downloadable through the client SDK's REST surface.
const deliveredEvent = events.find((e) => e.type === 'file_delivered')
if (deliveredEvent?.type === 'file_delivered') {
  const files = await client.listSessionFiles(session.id)
  const downloaded = await client.fetchSessionFile(session.id, deliveredEvent.path)
  if (!files.some((f) => f.path === deliveredEvent.path)) {
    fail(`Delivered path ${deliveredEvent.path} missing from GET /files: ${JSON.stringify(files)}`)
  }
  if (!downloaded.includes('348')) {
    fail(`Downloaded ${deliveredEvent.path} does not contain 348 — got: ${downloaded}`)
  }
  console.log(`✅ file_delivered + REST download round-tripped: ${deliveredEvent.path}`)
} else if (report) {
  console.log('⚠️  Model wrote the report but never called deliver_file — no download card.')
}

console.log(`\nSession ${session.id}`)
console.log(`  bridged executions answered by the client: ${clientExecutions}`)
console.log(`  events streamed over WS: ${events.length}`)
console.log('\n✅ Full stack exercised: provider → server → WS → client SDK → client sandbox → replay → completion.\n')

host.dispose()
handle.closeSession()
await server.close()
process.exit(0)

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => '   │ ' + line)
    .join('\n')
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
