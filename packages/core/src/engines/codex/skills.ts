import type { SkillInfo } from '@workerdeck/protocol'
import type { AppServerSkillMetadata, AppServerSkillsListResponse, AppServerUserInput } from './types.ts'

export type SkillCatalog = { skills: SkillInfo[]; paths: Map<string, string> }

const SKILL_MENTION = /(^|[^A-Za-z0-9_$-])\$([a-z0-9][a-z0-9-]*)(?![A-Za-z0-9_-])/g

export function withSkillItems(input: readonly AppServerUserInput[], paths: ReadonlyMap<string, string>): AppServerUserInput[] {
  const present = new Set(input.flatMap((item) => (item.type === 'skill' ? [item.name] : [])))
  const added: AppServerUserInput[] = []
  for (const item of input) {
    if (item.type !== 'text') {
      continue
    }
    for (const match of item.text.matchAll(SKILL_MENTION)) {
      const name = match[2]!
      const path = paths.get(name)
      if (path === undefined || present.has(name)) {
        continue
      }
      present.add(name)
      added.push({ type: 'skill', name, path })
    }
  }
  return added.length > 0 ? [...input, ...added] : [...input]
}

export function mentionsSkill(input: readonly AppServerUserInput[]): boolean {
  return input.some((item) => item.type === 'text' && /(^|[^A-Za-z0-9_$-])\$[a-z0-9]/.test(item.text))
}

export function skillCatalog(result: AppServerSkillsListResponse | undefined): SkillCatalog {
  const entries = Array.isArray(result?.data) ? result.data : []
  const seen = new Set<string>()
  const skills: SkillInfo[] = []
  const paths = new Map<string, string>()
  for (const entry of entries) {
    for (const skill of entry?.skills ?? []) {
      if (typeof skill?.name !== 'string' || seen.has(skill.name)) {
        continue
      }
      seen.add(skill.name)
      skills.push(skillInfo(skill))
      if (typeof skill.path === 'string' && skill.path) {
        paths.set(skill.name, skill.path)
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, paths }
}

function skillInfo(skill: AppServerSkillMetadata): SkillInfo {
  return {
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    ...((skill.interface?.shortDescription ?? skill.shortDescription)
      ? { shortDescription: skill.interface?.shortDescription ?? skill.shortDescription }
      : {}),
    ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
    ...(skill.interface?.defaultPrompt ? { defaultPrompt: skill.interface.defaultPrompt } : {}),
    ...(skill.scope ? { scope: skill.scope } : {}),
    // Codex omits `enabled` for a skill it considers live; defaulting to false would hide it.
    enabled: skill.enabled !== false,
  }
}
