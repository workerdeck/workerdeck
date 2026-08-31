import { describe, expect, it } from 'vitest'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, runScript, type SandboxEngine } from '../src/index.ts'

let enginePromise: Promise<SandboxEngine> | undefined
function engine() {
  return (enginePromise ??= loadEngine(variant))
}

describe('runScript', () => {
  it('evaluates a script and returns its completion value', async () => {
    const result = await runScript(await engine(), { script: '1 + 1' })
    expect(result).toMatchObject({ ok: true, value: 2 })
  })

  it('captures console output', async () => {
    const result = await runScript(await engine(), {
      script: 'console.log("a", {b: 1}); console.error("bad"); 0',
    })
    expect(result.logs).toEqual([
      { level: 'log', text: 'a {"b":1}' },
      { level: 'error', text: 'bad' },
    ])
  })

  it('resolves async scripts (asyncified host calls look synchronous too)', async () => {
    const result = await runScript(await engine(), {
      script: '(async () => { return 40 + 2 })()',
    })
    expect(result).toMatchObject({ ok: true, value: 42 })
  })

  it('reads, writes, and lists the scoped VFS', async () => {
    const vfs = createVfs({ '/docs/a.txt': 'alpha' })
    const result = await runScript(await engine(), {
      vfs,
      script: `
        const input = vfs.read('/docs/a.txt')
        vfs.write('/out/result.txt', input.toUpperCase())
        vfs.list('/')
      `,
    })
    expect(result).toMatchObject({ ok: true, value: ['/docs/a.txt', '/out/result.txt'] })
    expect(vfs.read('/out/result.txt')).toBe('ALPHA')
  })

  it('isolates state: nothing leaks between runs', async () => {
    await runScript(await engine(), {
      vfs: createVfs(),
      script: 'globalThis.leak = "x"; vfs.write("/leak.txt", "x")',
    })
    const second = await runScript(await engine(), {
      vfs: createVfs(),
      script: 'JSON.stringify([typeof globalThis.leak, vfs.list("/")])',
    })
    expect(second).toMatchObject({ ok: true, value: '["undefined",[]]' })
  })

  it('turns a guest exception into a structured failed result', async () => {
    const result = await runScript(await engine(), { script: 'throw new Error("boom")' })
    expect(result).toMatchObject({ ok: false, reason: 'exception' })
    expect((result as { error: string }).error).toContain('boom')
  })

  it('red team: prototype-chain walk to the Function constructor stays inside the guest realm', async () => {
    const result = await runScript(await engine(), {
      script: `
        const G = ({}).constructor.constructor('return globalThis')()
        JSON.stringify({
          process: typeof G.process,
          require: typeof G.require,
          fetch: typeof G.fetch,
          Deno: typeof G.Deno,
          sameRealm: G === globalThis,
        })
      `,
    })
    expect(result.ok).toBe(true)
    expect(JSON.parse((result as { value: string }).value)).toEqual({
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      Deno: 'undefined',
      sameRealm: true,
    })
  })

  it('red team: infinite loop is preempted by the interrupt deadline', async () => {
    const started = Date.now()
    const result = await runScript(await engine(), {
      script: 'while (true) {}',
      timeoutMs: 200,
    })
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  // The outer timeout must exceed the guest deadline below, or vitest's 5s default decides the outcome instead of the memory cap
  // under test — which flaked on CI about every other run. Big chunks reach the cap in few iterations; only the result shape is asserted.
  it('red team: runaway allocation hits the memory cap as a failed result, not a host crash', async () => {
    const result = await runScript(await engine(), {
      script: 'const a = []; while (true) { a.push(new Uint8Array(512 * 1024)) }',
      memoryLimitBytes: 8 * 1024 * 1024,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toBe('oom')
  }, 20_000)

  it('red team: network is deny-by-default — fetchText without a grant throws in-guest', async () => {
    const result = await runScript(await engine(), {
      script: 'try { fetchText("https://example.com") } catch (e) { "denied: " + e.message }',
    })
    expect(result).toMatchObject({ ok: true })
    expect((result as { value: string }).value).toContain('denied:')
  })

  it('red team: no ambient authority — timers, fs, and module escape hatches are absent', async () => {
    const result = await runScript(await engine(), {
      script: `JSON.stringify([
        typeof setTimeout, typeof setInterval, typeof XMLHttpRequest,
        typeof WebAssembly, typeof importScripts,
      ])`,
    })
    expect(result).toMatchObject({ ok: true })
    expect(JSON.parse((result as { value: string }).value)).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
  })

  it('gated fetch: the host callback is the only path to the network', async () => {
    const seen: string[] = []
    const result = await runScript(await engine(), {
      fetchText: async (url) => {
        seen.push(url)
        return 'body-for-' + url
      },
      script: 'fetchText("https://ok.example/doc")',
    })
    expect(result).toMatchObject({ ok: true, value: 'body-for-https://ok.example/doc' })
    expect(seen).toEqual(['https://ok.example/doc'])
  })

  it('gated fetch: host rejection surfaces as a catchable guest error', async () => {
    const result = await runScript(await engine(), {
      fetchText: async () => {
        throw new Error('host says no')
      },
      script: 'try { fetchText("https://blocked.example") } catch (e) { e.message }',
    })
    expect(result).toMatchObject({ ok: true })
    expect((result as { value: string }).value).toContain('host says no')
  })
})
