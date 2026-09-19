// pnpm smoke:live-approval [provider] [model-id]   - spends tokens, never part of `pnpm test`.
//
// Edit-then-approve against a real provider. `smoke:live` drives tools by hand and configures no
// executor, so it never reaches the runner's own approval dispatch; this one does, and it is the
// only place the amended tool input meets a real model's next leg rather than a mock's.
//
// Only the FIRST call is edited, and the edit writes a file no script of the model's would: the
// proof that the edit *ran* is then a VFS entry rather than anything the model chose to say, so
// the smoke does not rest on a model behaving. Later calls are approved as written, which lets
// the turn finish instead of looping on a rewrite it cannot get past.
import { tool } from 'ai'
import { z } from 'zod'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine } from '@workerdeck/sandbox'
import { AiSdkRunner, QuickJsExecutor } from '@workerdeck/core'
import type { SessionEvent } from '@workerdeck/protocol'
import { resolveProvider, sleep } from './lib/providers.ts'

const PROOF = '/approval-proof.txt'
const SENTINEL = '90210'

const { providerName, modelId, factory } = await resolveProvider(process.argv.slice(2), 'smoke:live-approval')

console.log(`\nProvider: ${providerName}   Model: ${modelId}`)
console.log('='.repeat(60))

const engine = await loadEngine(variant)
const executor = new QuickJsExecutor({ engine })
const vfs = createVfs({ '/leads/acme.txt': 'company: Acme Corp\nrevenue: 4173\nemployees: 12\n' })

const runner = new AiSdkRunner({
  languageModel: factory(modelId),
  instructions:
    'You evaluate sales leads. Use the eval_script tool to compute answers from files in the ' +
    'sandbox VFS - never guess numbers. The sandbox exposes vfs.read(path), vfs.write(path, text), ' +
    'and vfs.list(dir). The value of the last expression in your script is returned to you. ' +
    'Report whatever the tool returns, even if it surprises you.',
  tools: {
    eval_script: tool({
      description: 'Run a JavaScript snippet in a sandbox with access to the scratch filesystem via the vfs global.',
      inputSchema: z.object({ script: z.string().describe('JavaScript to evaluate') }),
    }),
  },
  executor,
  vfs,
  executionLimits: { timeoutMs: 5000 },
  shouldApprove: (call) => call.toolName === 'eval_script',
})

let approvals = 0
let edited: string | undefined

runner.subscribe((event: SessionEvent) => {
  if (event.type === 'permission_requested') {
    approvals += 1
    const original = (event.request.input as { script?: string }).script ?? ''
    console.log(`\n🔐 approval asked for ${event.request.toolName}`)
    console.log(`   model wrote: ${original.replace(/\s+/g, ' ').slice(0, 90)}`)
    if (edited === undefined) {
      edited = `vfs.write('${PROOF}', '${SENTINEL}'); ${SENTINEL}`
      console.log(`   approving the first call with an edited script that writes ${PROOF}`)
      runner.resolvePermission(event.request.id, { behavior: 'allow', updatedInput: { script: edited } })
    } else {
      console.log('   approving as written')
      runner.resolvePermission(event.request.id, { behavior: 'allow' })
    }
  }
  if (event.type === 'execution_dispatched') {
    console.log(`\n⚙️  dispatched ${event.toolName} (${event.backend})`)
  }
  if (event.type === 'turn_result') {
    console.log(`\n🏁 turn_result: ${event.subtype} (${event.durationMs}ms)`)
  }
  if (event.type === 'session_error') {
    console.error('\n❗ session_error:', event.message)
  }
})

void runner.start()
runner.sendMessage('Read /leads/acme.txt and tell me the revenue per employee, rounded to the nearest whole number.')

const deadline = Date.now() + 120_000
let completed = false
runner.subscribe((e) => {
  if (e.type === 'turn_result') {
    completed = true
  }
})
while (!completed && Date.now() < deadline) {
  await sleep(50)
}

console.log('\n' + '='.repeat(60))
if (!completed) {
  console.error('\n❌ Timed out before the turn completed.\n')
  process.exit(1)
}

// What the unit tests assert against a mock, re-asserted against a real provider: the approval
// happened, the edited script is what actually executed, and the history the model continued
// from carries the edit rather than the script it wrote.
const files = vfs.snapshot() as Record<string, string>
const history = JSON.stringify(runner.messages)
const failures: string[] = []
if (approvals === 0) {
  failures.push('no approval was ever requested - shouldApprove did not fire')
}
if (files[PROOF] !== SENTINEL) {
  failures.push(`${PROOF} is ${JSON.stringify(files[PROOF])} - the edited script never ran`)
}
if (edited !== undefined && !history.includes(edited)) {
  failures.push('the amended script is absent from the model history')
}

console.log(`\napprovals: ${approvals}`)
console.log(`VFS after the run: ${JSON.stringify(files)}`)
if (failures.length > 0) {
  console.error('\n❌ ' + failures.join('\n❌ ') + '\n')
  process.exit(1)
}
console.log(`\n✅ the edited input ran, and the model continued from a history that agrees with it.\n`)
await runner.close()
