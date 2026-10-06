import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RELAY_ALL_OPS, RELAY_OPS, isRelayOp, type RelayOp, type RelaySessionEntry } from '@workerdeck/relay-client'

export type RelayRule = {
  from: string
  to: string
  allow: RelayOp[]
  projects?: string[]
  crossOperator?: boolean
}

export const RULES_FILE = 'rules.json'

export function rulesPath(stateDir: string): string {
  return join(stateDir, RULES_FILE)
}

export function parseRules(value: unknown): RelayRule[] {
  const list = (value as { rules?: unknown } | null)?.rules
  if (!Array.isArray(list)) {
    throw new Error('rules file must be an object with a "rules" array')
  }
  return list.map((raw, index) => {
    const rule = raw as { from?: unknown; to?: unknown; allow?: unknown; scope?: { projects?: unknown }; crossOperator?: unknown }
    const where = `rules[${index}]`
    if (typeof rule?.from !== 'string' || typeof rule.to !== 'string' || !rule.from || !rule.to) {
      throw new Error(`${where}: "from" and "to" must be gateway names or "*"`)
    }
    if (rule.allow !== undefined && (!Array.isArray(rule.allow) || !rule.allow.every(isRelayOp))) {
      throw new Error(`${where}: "allow" must list ops from ${RELAY_ALL_OPS.map((op) => `"${op}"`).join(', ')}`)
    }
    if (rule.crossOperator !== undefined && typeof rule.crossOperator !== 'boolean') {
      throw new Error(`${where}: "crossOperator" must be true or false`)
    }
    const projects = rule.scope?.projects
    if (
      projects !== undefined &&
      (!Array.isArray(projects) || !projects.every((path) => typeof path === 'string' && path.startsWith('/')))
    ) {
      throw new Error(`${where}: "scope.projects" must list absolute paths`)
    }
    return {
      from: rule.from,
      to: rule.to,
      allow: rule.allow === undefined ? [...RELAY_OPS] : [...new Set(rule.allow as RelayOp[])],
      ...(projects ? { projects: projects as string[] } : {}),
      ...(rule.crossOperator === true ? { crossOperator: true } : {}),
    }
  })
}

export async function readRules(stateDir: string): Promise<RelayRule[]> {
  let text: string
  try {
    text = await readFile(rulesPath(stateDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  return parseRules(JSON.parse(text))
}

function underPath(path: string | undefined, root: string): boolean {
  if (!path) {
    return false
  }
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`)
}

function inScope(rule: RelayRule, entry: RelaySessionEntry): boolean {
  return !rule.projects || rule.projects.some((root) => underPath(entry.cwd, root) || underPath(entry.project?.root, root))
}

// Union of every matching rule, intersected with what the target gateway accepts at all. Empty means
// the session is invisible to the requester. A plain rule matches gateways of one owner only, a
// crossOperator rule gateways of different owners only.
export function allowedOps(
  rules: readonly RelayRule[],
  from: string,
  to: string,
  entry: RelaySessionEntry,
  ceiling: ReadonlySet<RelayOp>,
  crossOperator = false,
): RelayOp[] {
  const ops = new Set<RelayOp>()
  for (const rule of rules) {
    if (
      (rule.crossOperator === true) === crossOperator &&
      (rule.from === '*' || rule.from === from) &&
      (rule.to === '*' || rule.to === to) &&
      inScope(rule, entry)
    ) {
      for (const op of rule.allow) {
        ops.add(op)
      }
    }
  }
  return RELAY_ALL_OPS.filter((op) => ops.has(op) && ceiling.has(op))
}
