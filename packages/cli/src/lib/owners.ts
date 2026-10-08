import { parseArgs } from 'node:util'

const HELP = `usage: workerdeck owners rename <from> <to> [--url URL] [--token TOKEN] [--header name=value]

Moves every agent and session stamped <from> to <to> on a running gateway (operator only).
<to> must be an owner the gateway knows. Refused while an agent of <from> holds a team edge
to another gateway.
`

export async function runOwners(argv: string[]): Promise<number> {
  let parsed: { values: { url: string; token?: string; header: string[]; help: boolean }; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string', default: process.env.WORKERDECK_URL ?? 'http://127.0.0.1:8787/v1' },
        token: { type: 'string', default: process.env.WORKERDECK_TOKEN },
        header: { type: 'string', multiple: true, default: [] },
        help: { type: 'boolean', default: false },
      },
    }) as typeof parsed
  } catch (error) {
    process.stderr.write(`owners: ${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const { values, positionals } = parsed
  const [command, from, to] = positionals
  if (values.help || command !== 'rename' || !from || !to) {
    process.stdout.write(HELP)
    return values.help ? 0 : 2
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (values.token) {
    headers.authorization = `Bearer ${values.token}`
  }
  for (const entry of values.header) {
    const at = entry.indexOf('=')
    if (at > 0) {
      headers[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
    }
  }
  let res: Response
  try {
    res = await fetch(`${values.url.replace(/\/$/, '')}/owners/rename`, { method: 'POST', headers, body: JSON.stringify({ from, to }) })
  } catch (error) {
    process.stderr.write(`owners: gateway unreachable at ${values.url} (${error instanceof Error ? error.message : String(error)})\n`)
    return 2
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; agents?: number; sessions?: number }
  if (!res.ok) {
    process.stderr.write(`owners: ${body.error ?? `rename failed with ${res.status}`}\n`)
    return 1
  }
  process.stdout.write(`renamed ${from} to ${to}: ${body.agents ?? 0} agents, ${body.sessions ?? 0} sessions\n`)
  return 0
}
