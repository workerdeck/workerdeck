import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createFileSessionStore, isDormant, reloadPlan, type CarriedSession, type SessionStore } from '@workerdeck/server'
import type { CliFlags } from '../config.ts'
import type { Instance } from '../lib/instance.ts'
import { installShutdown } from '../lib/shutdown.ts'

type Registry = Instance['server']['registry']
type CarriedRunner = NonNullable<ReturnType<Registry['get']>>
type Parking = Instance['server']['parking']

const here = fileURLToPath(import.meta.url)
const packagesDir = resolve(dirname(here), '..', '..', '..')

const CTRL_C = '\u0003'
const CTRL_R = '\u0012'

function line(text: string): void {
  process.stdout.write(`${text}\n`)
}

// A provider session is never carried by identity: its executors close over the generation's bridge hub, so a
// carried one fails every LATER bridged call with no_client while a client is attached, not merely the one in
// flight. It takes the ordinary restart path instead, which needs its snapshot on disk before the close.
// `snapshot()` is side-effect free, so probing it is how we learn whether an interrupt is owed.
async function persistProvider(parking: Parking, runner: CarriedRunner): Promise<'kept' | 'interrupted' | 'lost'> {
  let how: 'kept' | 'interrupted' = 'kept'
  if (!runner.snapshot?.()) {
    // The documented way out of every state snapshot refuses: it aborts the model call, settles pending executions
    // as interrupted and emits the failed turn_result whose write-through then runs.
    await runner.interrupt()
    how = 'interrupted'
  }
  const before = Date.now()
  parking.touch(runner)
  await parking.flush(runner.id)
  const record = await parking.get(runner.id)
  return record && !isDormant(record) && record.parkedAt >= before ? how : 'lost'
}

// Runs the gateway inside a shell that can re-evaluate every module under `packages/` in place, carrying the live
// runners - and therefore their engine child processes, subagents and shell grandchildren - across the swap.
// Dev only: the published CLI is a single bundled file with no subgraph to re-evaluate.
//
// `unsupported` rather than a throw: the flag reaches this CLI from a VS Code setting and a config file as well as
// from a keyboard, and a gateway that refuses to start because one dev convenience is unavailable is the worse
// failure. The caller serves without it and says so.
export async function runHotReload(flags: CliFlags): Promise<number | 'unsupported'> {
  if (!here.endsWith('.ts') || !existsSync(join(packagesDir, 'server', 'src'))) {
    process.stderr.write(
      '[workerdeck] --hot-reload needs a source checkout; this build is one bundled file with nothing to swap.\n' +
        '            Serving without it. Run it as `pnpm cli --hot-reload` from the repo instead.\n',
    )
    return 'unsupported'
  }

  // A namespace lookup, not a named import: `registerHooks` landed in Node 22.15, and a runtime without it (an
  // older Node, or Bun) must reach the unsupported path below rather than fail to load this module at all.
  const registerHooks = (nodeModule as Partial<typeof nodeModule>).registerHooks
  if (!registerHooks) {
    process.stderr.write(
      '[workerdeck] --hot-reload needs `module.registerHooks`, which this runtime does not provide (Node 22.15+).\n' +
        '            Serving without it.\n',
    )
    return 'unsupported'
  }

  const packagesUrl = `${pathToFileURL(packagesDir).href}/`
  let generation = 0

  // Only our own sources are versioned. node_modules stays at one copy per package on purpose: a second Agent SDK,
  // a second `ws`, or a second quickjs would each be a different kind of disaster.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context)
      if (generation === 0 || typeof result.url !== 'string') {
        return result
      }
      if (!result.url.startsWith(packagesUrl) || result.url.includes('/node_modules/')) {
        return result
      }
      return { ...result, url: `${result.url}${result.url.includes('?') ? '&' : '?'}wdgen=${generation}` }
    },
  })

  let baseStore: SessionStore | undefined
  let stateDir: string | null = null
  let pidPath: string | undefined

  const start = async (carried: CarriedSession[]): Promise<Instance> => {
    const config = (await import(`${packagesUrl}cli/src/config.ts`)) as typeof import('../config.ts')
    const lib = (await import(`${packagesUrl}cli/src/lib/instance.ts`)) as typeof import('../lib/instance.ts')
    const loaded = await config.loadConfigFile(flags.config)
    const resolved = config.resolveInstanceConfig(flags, loaded)
    stateDir = resolved.stateDir
    // One store object for the whole process. A file store is single-process by contract, and two generations
    // holding two of them over one directory is exactly the two-servers-one-directory case it refuses to be; an
    // in-memory one is worse, because a reload would drop every record it holds.
    if (resolved.stateDir && !resolved.options.parking?.store) {
      baseStore ??= createFileSessionStore({ dir: join(resolved.stateDir, 'parked') })
    }
    resolved.options.parking = {
      ...resolved.options.parking,
      ...(baseStore ? { store: baseStore } : {}),
      // Forced: the seam persists provider sessions rather than carrying them, and without this their snapshots
      // are never written, so a reload would end them.
      persistLive: true,
    }
    return await lib.startInstance(resolved, { quiet: generation > 0, carried })
  }

  let instance = await start([])
  let orphans: CarriedSession[] = []

  if (stateDir) {
    pidPath = join(stateDir, 'gateway.pid')
    // The state dir is created lazily by whoever writes into it first, and on a cold one that is nobody yet.
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(pidPath, `${process.pid}\n`)
    process.on('exit', () => {
      try {
        rmSync(pidPath!)
      } catch {}
    })
  }

  let reloading = false
  const reload = async (trigger: string): Promise<void> => {
    if (reloading) {
      return
    }
    reloading = true
    const started = Date.now()
    const persisted: string[] = []
    const dropped: string[] = []
    try {
      // One synchronous pass, because every later step keys off this classification and `info()` is synchronous.
      const carry: string[] = []
      const persist: CarriedRunner[] = []
      for (const info of instance.server.registry.list()) {
        const runner = instance.server.registry.get(info.id)
        if (!runner) {
          continue
        }
        const plan = reloadPlan(runner)
        if (plan === 'carry') {
          carry.push(runner.id)
        } else if (plan === 'persist') {
          persist.push(runner)
        } else {
          dropped.push(runner.id)
        }
      }

      // While this generation still owns them: `touch()` writes nothing for a runner its registry does not hold.
      for (const runner of persist) {
        persisted.push(`${runner.id} (${await persistProvider(instance.server.parking, runner)})`)
      }
      // Both halves matter: this generation's queued writes must land before `close()` skips them, and two managers
      // in one process share the file store's `${path}.${pid}.tmp`, so their writes must never overlap.
      await instance.server.parking.flush()

      for (const id of carry) {
        const released = instance.server.releaseSession(id)
        if (released) {
          orphans.push(released)
        }
      }
      await instance.close()
      generation += 1
      instance = await start(orphans)
      const adopted = new Set(instance.adopted)
      const ended = orphans.filter((carried) => !adopted.has(carried.runner.id)).map((carried) => carried.runner.id)
      orphans = []
      line(
        `[workerdeck] reloaded on ${trigger}: gen ${generation} in ${Date.now() - started}ms, ` +
          `${adopted.size} carried${persisted.length ? `, persisted ${persisted.join(', ')}` : ''}` +
          `${dropped.length ? `, dropped ${dropped.join(', ')}` : ''}${ended.length ? `, ended while held ${ended.join(', ')}` : ''}`,
      )
    } catch (error) {
      line(`[workerdeck] reload failed at gen ${generation}: ${error instanceof Error ? error.message : String(error)}`)
      if (orphans.length > 0) {
        line(`[workerdeck] holding ${orphans.length} session(s): ${orphans.map((carried) => carried.runner.id).join(', ')}`)
        line('[workerdeck] their turns keep running and their transcripts are buffered, but nothing can attach and')
        line('[workerdeck] no push or webhook goes out until a generation starts. Fix the error and reload again,')
        line('[workerdeck] or ctrl-c to stop (the sessions close; their records are kept).')
      }
    } finally {
      reloading = false
    }
  }

  const shutdown = installShutdown({
    current: () => instance,
    // Held across a failed generation, so no registry holds them and `close()` cannot reach them. Nothing else
    // would end their engine children promptly.
    alsoClose: () => orphans.map((carried) => carried.runner),
    log: line,
  })

  process.on('SIGUSR2', () => void reload('SIGUSR2'))
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (key: string) => {
      if (key === CTRL_R) {
        void reload('ctrl-r')
        return
      }
      // Raw mode swallows SIGINT, so ctrl-c arrives as a byte and has to be re-spelled as the shutdown it was.
      if (key === CTRL_C) {
        shutdown('SIGINT')
      }
    })
    process.on('exit', () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
    })
  }

  line(`  hot reload: ctrl-r${pidPath ? ', `workerdeck reload`' : ''}, or SIGUSR2 to pid ${process.pid}`)
  line('')

  // Never resolves: every exit from here runs through `installShutdown`, which closes the current instance and
  // exits. Awaiting `instance.closed` instead would return the moment a reload closed the generation it captured.
  await new Promise<void>(() => {})
  return 0
}
