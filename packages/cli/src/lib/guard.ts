import { parseArgs } from 'node:util'

/**
 * Restart guard for a deploy: ask a running instance whether anything would be
 * lost by stopping it, and exit non-zero while the answer is yes.
 *
 *   workerdeck guard --wait 300 --allow-parked && launchctl kickstart -k …
 *
 * Exit codes: 0 safe to restart, 1 still busy, 2 could not tell (bad URL, auth,
 * or an unexpected response — never treated as safe). `--allow-parked` /
 * `--allow-queued` are the operator asserting a durable SessionStore / durable
 * QueueAdapter; see `docs/PACKAGES.md`.
 */

const BUSY_STATUSES = new Set(['starting', 'running', 'awaiting_approval'])

const HELP = `usage: workerdeck guard [--url URL] [--token TOKEN] [--header name=value]
                           [--wait SECONDS] [--interval SECONDS]
                           [--allow-parked] [--allow-queued] [--json]

exit 0 = safe to restart, 1 = busy, 2 = could not tell
`

type GetResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 'unreachable' }
  | { ok: false; code?: number; detail: string }

type Verdict = {
  reasons: string[]
  notes: string[]
  unreachable?: boolean
  error?: string
  sessions?: number
  parked?: number
}

class GuardError extends Error {}

export const runGuard = async (argv: string[]): Promise<number> => {
  let values: {
    url: string
    token?: string
    header: string[]
    wait: string
    interval: string
    'allow-parked': boolean
    'allow-queued': boolean
    json: boolean
    help: boolean
  }
  try {
    values = parseArgs({
      args: argv,
      options: {
        url: {
          type: 'string',
          default: process.env.WORKERDECK_URL ?? 'http://127.0.0.1:8787/v1',
        },
        token: { type: 'string', default: process.env.WORKERDECK_TOKEN },
        header: { type: 'string', multiple: true, default: [] },
        wait: { type: 'string', default: '0' },
        interval: { type: 'string', default: '5' },
        'allow-parked': { type: 'boolean', default: false },
        'allow-queued': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values as typeof values
  } catch (error) {
    process.stderr.write(`guard: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }

  const base = values.url.replace(/\/$/, '')
  const headers: Record<string, string> = { accept: 'application/json' }
  // The token covers the common `Authorization: Bearer` case, including this
  // CLI's own --auth-key; --header covers hosts whose `authenticate` hook reads
  // something else.
  if (values.token) {
    headers.authorization = `Bearer ${values.token}`
  }

  const seconds = (flag: string, raw: string): number => {
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) {
      throw new GuardError(`${flag} must be a non-negative number of seconds`)
    }
    return value
  }

  let waitMs: number
  let intervalMs: number
  try {
    for (const entry of values.header) {
      const at = entry.indexOf('=')
      if (at < 1) {
        throw new GuardError(`--header must be name=value, got '${entry}'`)
      }
      headers[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
    }
    waitMs = seconds('--wait', values.wait) * 1000
    intervalMs = Math.max(seconds('--interval', values.interval), 1) * 1000
  } catch (error) {
    process.stderr.write(`guard: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const get = async (path: string): Promise<GetResult> => {
    let res: Response
    try {
      res = await fetch(base + path, { headers })
    } catch (error) {
      // Nothing listening on the URL we were pointed at: there is no session to lose.
      const code = (error as { cause?: { code?: string } })?.cause?.code
      if (code === 'ECONNREFUSED') {
        return { ok: false, status: 'unreachable' }
      }
      return { ok: false, detail: String(error instanceof Error ? error.message : error) }
    }
    if (!res.ok) {
      return { ok: false, code: res.status, detail: `HTTP ${res.status}` }
    }
    try {
      return { ok: true, body: (await res.json()) as Record<string, unknown> }
    } catch {
      return { ok: false, code: res.status, detail: 'response was not JSON' }
    }
  }

  /** One look at the server. Returns the reasons a restart would cost something. */
  const inspect = async (): Promise<Verdict> => {
    const sessions = await get('/sessions')
    if (!sessions.ok && 'status' in sessions) {
      return { unreachable: true, reasons: [], notes: [] }
    }
    if (!sessions.ok) {
      return { error: `GET ${base}/sessions → ${sessions.detail}`, reasons: [], notes: [] }
    }
    const listed = sessions.body.sessions
    if (!Array.isArray(listed)) {
      return { error: `GET ${base}/sessions returned no session list`, reasons: [], notes: [] }
    }
    const all = listed as { id: string; status: string }[]

    const reasons: string[] = []
    /** Worth saying out loud, but not worth blocking a deploy over. */
    const notes: string[] = []
    for (const session of all.filter((s) => BUSY_STATUSES.has(s.status))) {
      reasons.push(`session ${session.id} is ${session.status}`)
    }
    const parked = all.filter((s) => s.status === 'parked')
    if (parked.length > 0 && !values['allow-parked']) {
      reasons.push(
        `${parked.length} parked session(s) — pass --allow-parked once the server ` +
          'runs a durable SessionStore, or they are lost on restart',
      )
    }

    // A queue is optional: 404 here means this server declares none.
    const queue = await get('/queue')
    if (!queue.ok && !('status' in queue) && queue.code !== 404) {
      return { error: `GET ${base}/queue → ${queue.detail}`, reasons: [], notes: [] }
    }
    const stats = queue.ok ? (queue.body.stats as { running?: number; queued?: number; parked?: number } | undefined) : undefined
    if ((stats?.running ?? 0) > 0) {
      reasons.push(`${stats!.running} job(s) running`)
    }
    if ((stats?.queued ?? 0) > 0 && !values['allow-queued']) {
      reasons.push(
        `${stats!.queued} job(s) queued — pass --allow-queued once the server runs a ` +
          'durable QueueAdapter, or they are lost on restart',
      )
    }
    if ((stats?.parked ?? 0) > 0 && values['allow-parked']) {
      // Not blocking — the operator has said parks are durable; session durability is not job durability.
      notes.push(
        `${stats!.parked} parked job(s): their queue-side records are the QueueAdapter's, ` +
          "not the SessionStore's — with the in-memory adapter they never finish",
      )
    }
    return { reasons, notes, sessions: all.length, parked: parked.length }
  }

  const report = (verdict: string, detail: Verdict): void => {
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ verdict, ...detail })}\n`)
      return
    }
    const lines = [...detail.reasons.map((reason) => `  - ${reason}`), ...detail.notes.map((note) => `  note: ${note}`)].join('\n')
    process.stdout.write(`guard: ${verdict}${lines ? `\n${lines}` : ''}\n`)
  }

  const deadline = Date.now() + waitMs
  for (;;) {
    const result = await inspect()
    if (result.error) {
      report('unknown', { ...result, reasons: [result.error] })
      return 2
    }
    if (result.unreachable) {
      report('safe to restart (nothing listening on the given URL)', result)
      return 0
    }
    if (result.reasons.length === 0) {
      report('safe to restart', result)
      return 0
    }
    if (Date.now() + intervalMs > deadline) {
      report('busy — not safe to restart', result)
      return 1
    }
    report(`busy, waiting up to ${Math.round((deadline - Date.now()) / 1000)}s`, result)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
