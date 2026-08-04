/**
 * Manual smoke for the QuickJS sandbox boundary. No API key, no network, no cost.
 *
 *   pnpm smoke:sandbox            # run the built-in scenarios
 *   pnpm smoke:sandbox 'vfs.list("/")'   # run your own script in the sandbox
 *
 * Every scenario prints what it proves, so a green run is readable as evidence
 * rather than a pile of PASS lines.
 */
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, runScript, type RunScriptResult } from '@workerdeck/sandbox'

const engine = await loadEngine(variant)

const custom = process.argv.slice(2).join(' ').trim()
if (custom) {
  const vfs = createVfs({ '/docs/example.txt': 'revenue: 120' })
  console.log(`\nRunning your script (VFS seeded with /docs/example.txt):\n  ${custom}\n`)
  const result = await runScript(engine, { script: custom, vfs, timeoutMs: 5000 })
  report(result)
  console.log('\nVFS after the run:', vfs.snapshot())
  process.exit(result.ok ? 0 : 1)
}

let failures = 0

async function scenario(
  title: string,
  proves: string,
  run: () => Promise<{ ok: boolean; detail: string }>,
): Promise<void> {
  process.stdout.write(`\n▸ ${title}\n  proves: ${proves}\n`)
  const started = Date.now()
  try {
    const { ok, detail } = await run()
    if (!ok) failures += 1
    console.log(`  ${ok ? '✅' : '❌'} ${detail}  (${Date.now() - started}ms)`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ threw: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function report(result: RunScriptResult): void {
  if (result.ok) console.log('  value:', JSON.stringify(result.value))
  else console.log(`  failed (${result.reason}):`, result.error)
  for (const log of result.logs) console.log(`  guest ${log.level}:`, log.text)
}

console.log('QuickJS sandbox smoke — untrusted script boundary\n' + '='.repeat(50))

await scenario('Happy path: evaluate a document from the scratch VFS', 'the sandbox is actually useful', async () => {
  const vfs = createVfs({ '/leads/acme.txt': 'revenue: 120' })
  const result = await runScript(engine, {
    vfs,
    script: `
      const doc = vfs.read('/leads/acme.txt')
      const revenue = Number(doc.split('revenue:')[1].trim())
      vfs.write('/out/acme.json', JSON.stringify({ revenue }))
      revenue >= 100 ? 'qualified' : 'skip'
    `,
  })
  report(result)
  const wrote = vfs.read('/out/acme.json')
  return {
    ok: result.ok && result.value === 'qualified' && wrote === '{"revenue":120}',
    detail: `returned "qualified"; wrote ${wrote} to the in-memory VFS (never the host disk)`,
  }
})

await scenario(
  'Escape attempt: prototype chain to globalThis',
  'the CVE-2026-5752 failure shape — a guest reaching the host realm',
  async () => {
    const result = await runScript(engine, {
      script: `
        const G = ({}).constructor.constructor('return globalThis')()
        JSON.stringify({ process: typeof G.process, require: typeof G.require, fetch: typeof G.fetch })
      `,
    })
    report(result)
    const reached = result.ok ? (JSON.parse(String(result.value)) as Record<string, string>) : {}
    const clean = Object.values(reached).every((v) => v === 'undefined')
    return {
      ok: result.ok && clean,
      detail: clean
        ? 'reached globalThis — and it is the GUEST realm: process/require/fetch all undefined'
        : `LEAK: guest saw ${JSON.stringify(reached)}`,
    }
  },
)

await scenario('Escape attempt: read the host filesystem', 'no ambient filesystem authority', async () => {
  const result = await runScript(engine, {
    script: `JSON.stringify([typeof require, typeof process, typeof importScripts, typeof WebAssembly])`,
  })
  report(result)
  const all = result.ok ? (JSON.parse(String(result.value)) as string[]) : []
  const clean = all.length === 4 && all.every((t) => t === 'undefined')
  return { ok: clean, detail: clean ? 'no require/process/importScripts/WebAssembly to reach the disk with' : 'LEAK' }
})

await scenario('Denial of service: infinite loop', 'the wall-clock deadline preempts a hostile loop in-thread', async () => {
  const result = await runScript(engine, { script: 'while (true) {}', timeoutMs: 300 })
  report(result)
  return {
    ok: !result.ok && result.reason === 'timeout',
    detail: 'the interrupt handler stopped it — no worker thread, no cross-origin isolation needed',
  }
})

await scenario('Denial of service: runaway allocation', 'the allocator cap is real (this is what Extism could not enforce)', async () => {
  const result = await runScript(engine, {
    script: 'const a = []; while (true) { a.push(new Uint8Array(64 * 1024)) }',
    memoryLimitBytes: 8 * 1024 * 1024,
    timeoutMs: 15_000,
  })
  report(result)
  return {
    ok: !result.ok && result.reason === 'oom',
    detail: 'guest hit its 8 MiB cap and failed as data — the host process is fine',
  }
})

await scenario('Network: deny by default', 'no network unless the host grants it', async () => {
  const result = await runScript(engine, {
    script: 'try { fetchText("https://example.com") } catch (e) { "blocked: " + e.message }',
  })
  report(result)
  return { ok: result.ok && String(result.value).startsWith('blocked:'), detail: 'fetchText threw inside the guest' }
})

await scenario('Network: granted, but host-gated', 'the allowlist is enforced host-side; the guest never holds a credential', async () => {
  const seen: string[] = []
  const result = await runScript(engine, {
    // Stands in for QuickJsExecutor's gate: the host decides, and could attach a
    // credential here that the guest never sees.
    fetchText: async (url) => {
      seen.push(url)
      if (!url.startsWith('https://allowed.example/')) throw new Error(`host not allowed: ${url}`)
      return 'document body'
    },
    script: `
      const ok = fetchText('https://allowed.example/doc')
      let blocked
      try { fetchText('https://evil.example/steal'); blocked = 'NOT BLOCKED' }
      catch (e) { blocked = e.message }
      JSON.stringify({ ok, blocked })
    `,
  })
  report(result)
  const out = result.ok ? (JSON.parse(String(result.value)) as { ok: string; blocked: string }) : undefined
  return {
    ok: out?.ok === 'document body' && out.blocked.includes('not allowed'),
    detail: `host saw ${seen.length} attempts and allowed 1; the guest got a catchable error for the other`,
  }
})

await scenario('Isolation: nothing survives between runs', 'fresh context per call — no cross-task leakage', async () => {
  await runScript(engine, { vfs: createVfs(), script: 'globalThis.leak = "secret"; vfs.write("/leak.txt", "secret")' })
  const result = await runScript(engine, {
    vfs: createVfs(),
    script: 'JSON.stringify([typeof globalThis.leak, vfs.list("/")])',
  })
  report(result)
  return { ok: result.ok && String(result.value) === '["undefined",[]]', detail: 'second run saw no globals and an empty VFS' }
})

console.log('\n' + '='.repeat(50))
if (failures > 0) {
  console.error(`\n❌ ${failures} scenario(s) failed — the sandbox boundary is NOT holding.\n`)
  process.exit(1)
}
console.log('\n✅ All scenarios held. Try your own: pnpm smoke:sandbox \'<your script>\'\n')
