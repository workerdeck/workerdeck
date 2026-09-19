import type { SkillInfo, SlashCommandInfo } from '@workerdeck/protocol'

export type ClientCommand = {
  name: string
  description: string
  argumentHint?: string
  // Selecting the row populates the composer with `/name ` instead of resolving to a chip, so the
  // argument is typed before anything is submitted.
  requiresArgs?: boolean
  // True when the command consumed the input. False hands the text back to the engine, which is how
  // `/model` with no argument still reaches a CLI that implements it natively.
  run: (args: string) => boolean
}

export type ComposerRow =
  | { kind: 'command'; name: string; description?: string; argumentHint?: string; aliases?: string[] }
  | { kind: 'client'; name: string; description?: string; argumentHint?: string; command: ClientCommand }
  | { kind: 'skill'; name: string; label: string; description?: string; enabled: boolean; scope?: string; skill: SkillInfo }

const KIND_ORDER: Record<ComposerRow['kind'], number> = { command: 0, client: 1, skill: 2 }

export function cleanCommandName(name: string): string {
  return name.replace(/\s*\(MCP\)$/i, '')
}

export function skillPrompt(skill: SkillInfo): string {
  const base = skill.defaultPrompt?.trim() || `Use the ${skill.displayName ?? skill.name} skill:`
  return /\s$/.test(base) ? base : base + ' '
}

export function mergeComposerRows(sources: {
  commands?: readonly SlashCommandInfo[]
  clientCommands?: readonly ClientCommand[]
  skills?: readonly SkillInfo[]
}): ComposerRow[] {
  const rows: ComposerRow[] = []
  const engineNames = new Set<string>()
  for (const command of sources.commands ?? []) {
    const name = cleanCommandName(command.name)
    if (engineNames.has(name)) {
      continue
    }
    engineNames.add(name)
    for (const alias of command.aliases ?? []) {
      engineNames.add(cleanCommandName(alias))
    }
    rows.push({ kind: 'command', name, description: command.description, argumentHint: command.argumentHint, aliases: command.aliases })
  }
  for (const command of sources.clientCommands ?? []) {
    if (engineNames.has(command.name)) {
      continue
    }
    rows.push({ kind: 'client', name: command.name, description: command.description, argumentHint: command.argumentHint, command })
  }
  for (const skill of sources.skills ?? []) {
    rows.push({
      kind: 'skill',
      name: skill.name,
      label: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description,
      enabled: skill.enabled,
      scope: skill.scope,
      skill,
    })
  }
  return rows
}

function haystacks(row: ComposerRow): string[] {
  if (row.kind === 'skill') {
    return [row.name, row.label, ...row.name.split(/[-:_]/)]
  }
  return [row.name, ...(row.kind === 'command' ? (row.aliases ?? []) : []), ...row.name.split(':')]
}

export function matchScore(query: string, candidates: readonly string[]): number {
  const needle = query.toLowerCase()
  const lowered = candidates.map((s) => s.toLowerCase())
  if (lowered.some((h) => h.startsWith(needle))) {
    return 2
  }
  return lowered.some((h) => h.includes(needle)) ? 1 : 0
}

export function rankComposerRows(query: string, rows: readonly ComposerRow[]): ComposerRow[] {
  const scored: Array<{ score: number; index: number; row: ComposerRow }> = []
  rows.forEach((row, index) => {
    if (row.kind === 'skill' && !row.enabled) {
      return
    }
    const score = matchScore(query, haystacks(row))
    if (score > 0) {
      scored.push({ score, index, row })
    }
  })
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] || a.index - b.index)
  return scored.map(({ row }) => row)
}

export function matchClientCommand(text: string, commands: readonly ClientCommand[]): { command: ClientCommand; args: string } | undefined {
  const match = /^\/([\w:-]+)[ \t]*([\s\S]*)$/.exec(text.trim())
  if (!match) {
    return undefined
  }
  const command = commands.find((c) => c.name === match[1])
  return command ? { command, args: match[2]!.trim() } : undefined
}

// The serializable projection a native host (the VS Code QuickPick) renders. `insertText` is resolved here
// so no second surface reimplements skillPrompt or the leading slash.
export type ComposerCommandRow = {
  kind: ComposerRow['kind']
  name: string
  label: string
  description?: string
  scope?: string
  enabled: boolean
  insertText: string
}

export function composerCommandRows(rows: readonly ComposerRow[]): ComposerCommandRow[] {
  return rows.map((row) =>
    row.kind === 'skill'
      ? {
          kind: row.kind,
          name: row.name,
          label: row.label,
          description: row.description,
          scope: row.scope,
          enabled: row.enabled,
          insertText: skillPrompt(row.skill),
        }
      : {
          kind: row.kind,
          name: row.name,
          label: `/${row.name}`,
          description: row.description,
          enabled: true,
          insertText: `/${row.name} `,
        },
  )
}
