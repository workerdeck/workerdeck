import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolOutputTails } from '../../lib/tool-output.ts'

const POLL_MS = 500
const FIRST_READ_MAX = 16_384
const READ_MAX = 65_536
const LOCATE_ATTEMPTS = 6

// The CLI streams a foreground Bash task's output to `<tmp>/claude-<uid>/<cwd-slug>/<session>/tasks/<task>.output`
// while it runs, but only names that path once the command is backgrounded or settled. The cwd slug is the CLI's
// own encoding, so the session directory is found by listing, never by re-deriving the slug.
export function taskOutputRoots(env: Record<string, string | undefined>): string[] {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const name = uid === undefined ? 'claude' : `claude-${uid}`
  const bases = [env.CLAUDE_CODE_TMPDIR, '/tmp', tmpdir()].filter((base): base is string => typeof base === 'string' && base !== '')
  return [...new Set(bases.map((base) => join(base, name)))]
}

export function findTaskOutput(roots: string[], sessionId: string, taskId: string): string | undefined {
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = join(root, entry, sessionId, 'tasks', `${taskId}.output`)
      if (existsSync(candidate)) {
        return candidate
      }
    }
  }
  return undefined
}

export function tailTaskOutput(
  tails: ToolOutputTails,
  options: { toolUseId: string; taskId: string; sessionId: string; roots: string[]; pollMs?: number },
): void {
  const { toolUseId, taskId, sessionId, roots } = options
  let path: string | undefined
  let offset = 0
  let attempts = 0
  const poll = () => {
    if (!tails.has(toolUseId)) {
      return
    }
    if (path === undefined) {
      path = findTaskOutput(roots, sessionId, taskId)
      if (path === undefined) {
        if (++attempts >= LOCATE_ATTEMPTS) {
          tails.end(toolUseId)
        }
        return
      }
    }
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return
    }
    if (size <= offset) {
      return
    }
    if (offset === 0 && size > FIRST_READ_MAX) {
      offset = size - FIRST_READ_MAX
    }
    const length = Math.min(size - offset, READ_MAX)
    const buffer = Buffer.alloc(length)
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const read = readSync(fd, buffer, 0, length, offset)
      offset += read
      tails.append(toolUseId, buffer.subarray(0, read).toString('utf8'))
    } catch {
      return
    } finally {
      if (fd !== undefined) {
        closeSync(fd)
      }
    }
  }
  const timer = setInterval(poll, options.pollMs ?? POLL_MS)
  timer.unref?.()
  tails.track(toolUseId, () => clearInterval(timer))
  poll()
}
