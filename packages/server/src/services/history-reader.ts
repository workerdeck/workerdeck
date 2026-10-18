import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import type { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  INITIALIZE_PARAMS,
  JsonRpcError,
  claudeHistoryEvents,
  claudeSessionMessages,
  codexChildEnv,
  codexHistoryEvents,
  connectAppServer,
  resolveBundledCodexExecutable,
  resolveClaudeSdkEntry,
  withoutGatewaySecrets,
  type AppServerConnectFn,
  type AppServerHistoryTurn,
  type HistoryFn,
} from '@workerdeck/core'
import { errorMessage, type ProfileEngine, type ProfileInfo, type SessionEventBody } from '@workerdeck/protocol'
import { cliConfigDir } from '../lib/profile-env.ts'

export type HistoryTarget = {
  sessionId: string
  engine: ProfileEngine
  engineSessionId?: string
  profile?: string
  cwd: string
}

export type HistoryRead = { kind: 'ok'; events: SessionEventBody[] } | { kind: 'missing' } | { kind: 'failed'; error: string }

export interface HistoryReader {
  read(target: HistoryTarget, signal?: AbortSignal): Promise<HistoryRead>
}

export type ReaderChild = {
  stdout: Readable | null
  stderr: Readable | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
}

export type ReaderChildSpawn = (args: string[], env: Record<string, string>) => ReaderChild

export type HistoryReaderOptions = {
  profile?: (name: string) => ProfileInfo | undefined
  sessionEnvFor?: (profile: ProfileInfo) => Record<string, string | undefined>
  gatewayEnv?: Record<string, string | undefined>
  claudeHistory?: HistoryFn
  spawnChild?: ReaderChildSpawn
  claudeSdkEntry?: () => string | undefined
  codexConnect?: AppServerConnectFn
  maxConcurrent?: number
  timeoutMs?: number
}

type Job = (signal: AbortSignal) => Promise<HistoryRead>

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_TIMEOUT_MS = 20_000
const CHILD_OUTPUT_LIMIT = 256 * 1024 * 1024
const MISSING: HistoryRead = { kind: 'missing' }

const CLAUDE_CHILD_SCRIPT = [
  'const [entry, sessionId, dir] = process.argv.slice(1)',
  'const { getSessionMessages } = await import(entry)',
  'const messages = await getSessionMessages(sessionId, { dir })',
  'process.stdout.write(JSON.stringify(messages))',
].join('\n')

class ReadAborted extends Error {}

export function createHistoryReader(options: HistoryReaderOptions = {}): HistoryReader {
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const gatewayEnv = options.gatewayEnv ?? process.env
  const waiting: Array<() => void> = []
  let running = 0

  function release(): void {
    running--
    waiting.shift()?.()
  }

  function acquire(signal: AbortSignal | undefined): Promise<boolean> {
    if (running < maxConcurrent) {
      running++
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal?.removeEventListener('abort', drop)
        running++
        resolve(true)
      }
      const drop = () => {
        const index = waiting.indexOf(grant)
        if (index >= 0) {
          waiting.splice(index, 1)
        }
        resolve(false)
      }
      waiting.push(grant)
      signal?.addEventListener('abort', drop, { once: true })
    })
  }

  async function run(job: Job, outer: AbortSignal | undefined): Promise<HistoryRead> {
    if (outer?.aborted || !(await acquire(outer))) {
      return { kind: 'failed', error: 'history read aborted' }
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const forward = () => controller.abort()
    outer?.addEventListener('abort', forward, { once: true })
    try {
      return await job(controller.signal)
    } catch (error) {
      if (timedOut) {
        return { kind: 'failed', error: `history read timed out after ${timeoutMs} ms` }
      }
      if (error instanceof ReadAborted || controller.signal.aborted) {
        return { kind: 'failed', error: 'history read aborted' }
      }
      return { kind: 'failed', error: errorMessage(error) }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
      release()
    }
  }

  function envFor(profile: ProfileInfo | undefined): Record<string, string | undefined> {
    return profile && options.sessionEnvFor ? options.sessionEnvFor(profile) : gatewayEnv
  }

  async function readClaude(
    target: HistoryTarget,
    sessionId: string,
    profile: ProfileInfo | undefined,
    signal: AbortSignal,
  ): Promise<HistoryRead> {
    const env = envFor(profile)
    const configDir = profile?.configDir ?? cliConfigDir(env)
    const messages =
      canonicalDir(configDir) === canonicalDir(cliConfigDir(gatewayEnv))
        ? await abortable((options.claudeHistory ?? claudeSessionMessages)(sessionId, { dir: target.cwd }), signal)
        : await readClaudeInChild(sessionId, target.cwd, { ...env, CLAUDE_CONFIG_DIR: configDir }, signal)
    if (!Array.isArray(messages) || messages.length === 0) {
      return MISSING
    }
    const events = claudeHistoryEvents(messages)
    return events.length === 0 ? MISSING : { kind: 'ok', events }
  }

  async function readClaudeInChild(
    sessionId: string,
    dir: string,
    env: Record<string, string | undefined>,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<HistoryFn>>> {
    const entry = (options.claudeSdkEntry ?? resolveClaudeSdkEntry)()
    if (!entry) {
      throw new Error('the Claude Agent SDK could not be resolved for a history read')
    }
    const childEnv = definedEnv(withoutGatewaySecrets(env))
    const args = ['--input-type=module', '-e', CLAUDE_CHILD_SCRIPT, pathToFileURL(entry).href, sessionId, dir]
    const child = (options.spawnChild ?? defaultSpawn)(args, childEnv)
    const stdout = await collectChild(child, signal)
    return JSON.parse(stdout) as Awaited<ReturnType<HistoryFn>>
  }

  async function readCodex(threadId: string, profile: ProfileInfo | undefined, signal: AbortSignal): Promise<HistoryRead> {
    const connect = options.codexConnect ?? defaultCodexConnect
    const connection = connect({ env: codexChildEnv(envFor(profile), profile?.codexHome) })
    const onAbort = () => connection.close()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      connection.onRequest(async (method) => {
        throw new Error(`the history reader answers no requests (${method})`)
      })
      await abortable(connection.request('initialize', INITIALIZE_PARAMS), signal)
      connection.notify('initialized')
      let read: { thread?: { turns?: AppServerHistoryTurn[] } } | undefined
      try {
        read = (await abortable(connection.request('thread/read', { threadId, includeTurns: true }), signal)) as typeof read
      } catch (error) {
        if (codexThreadMissing(error)) {
          return MISSING
        }
        throw error
      }
      const turns = read?.thread?.turns
      if (!Array.isArray(turns) || turns.length === 0) {
        return MISSING
      }
      return { kind: 'ok', events: codexHistoryEvents(turns, { threadId }) }
    } finally {
      signal.removeEventListener('abort', onAbort)
      connection.close()
    }
  }

  return {
    read(target, signal) {
      if (target.engine === 'provider' || !target.engineSessionId) {
        return Promise.resolve(MISSING)
      }
      const engineSessionId = target.engineSessionId
      let profile: ProfileInfo | undefined
      if (target.profile !== undefined) {
        profile = options.profile?.(target.profile)
        if (options.profile && !profile) {
          return Promise.resolve({ kind: 'failed', error: `unknown profile: ${target.profile}` })
        }
      }
      if (profile?.engine === 'provider') {
        return Promise.resolve(MISSING)
      }
      const job: Job =
        target.engine === 'codex'
          ? (jobSignal) => readCodex(engineSessionId, profile, jobSignal)
          : (jobSignal) => readClaude(target, engineSessionId, profile, jobSignal)
      return run(job, signal)
    },
  }
}

function defaultSpawn(args: string[], env: Record<string, string>): ReaderChild {
  return spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
}

function defaultCodexConnect(connectOptions: Parameters<AppServerConnectFn>[0]): ReturnType<AppServerConnectFn> {
  const executable = resolveBundledCodexExecutable()
  if (!executable) {
    throw new Error('codex is not installed')
  }
  return connectAppServer({ executable, ...connectOptions })
}

// Measured on resume as -32600 "no rollout found for thread id"; thread/read is assumed to answer alike or with "not found".
function codexThreadMissing(error: unknown): boolean {
  return error instanceof JsonRpcError && /no rollout found|thread not found|not found/i.test(error.message)
}

function collectChild(child: ReaderChild, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (outcome: () => void) => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      outcome()
    }
    const onAbort = () => {
      child.kill('SIGKILL')
      finish(() => reject(new ReadAborted('history read aborted')))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
      if (stdout.length > CHILD_OUTPUT_LIMIT) {
        child.kill('SIGKILL')
        finish(() => reject(new Error('history reader output exceeded its limit')))
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-2000)
    })
    child.once('error', (error) => {
      child.kill('SIGKILL')
      finish(() => reject(new Error(`history reader failed to start: ${error.message}`)))
    })
    child.once('exit', (code, exitSignal) => {
      if (code === 0) {
        finish(() => resolve(stdout))
        return
      }
      const tail = stderr.trim().split('\n').pop()
      finish(() => reject(new Error(`history reader exited (${exitSignal ?? `code ${code}`})${tail ? `: ${tail}` : ''}`)))
    })
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(new ReadAborted('history read aborted'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {})
      reject(new ReadAborted('history read aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function canonicalDir(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}
