import { HttpError } from './http.ts'

export type ShellRouteAction = 'output' | 'kill' | 'agent-write'

export type SessionItemRoute =
  | { kind: 'session'; id: string }
  | { kind: 'ws'; id: string }
  | { kind: 'permission'; id: string; permissionId: string }
  | { kind: 'attachments'; id: string; attachmentId?: string }
  | { kind: 'produced'; id: string; producedFileId?: string }
  | { kind: 'shells'; id: string; shellId?: string; shellAction?: ShellRouteAction }
  | { kind: 'stop-task'; id: string; stopTaskId: string }
  | { kind: 'background-task'; id: string; backgroundTaskId?: string }
  | { kind: 'project-icon'; id: string }
  | { kind: 'tool-result'; id: string; resultSeq: number }
  | { kind: 'mcp'; id: string; mcpServer?: string }
  | { kind: 'files'; id: string; filePath?: string }
  | { kind: 'peers'; id: string }
  | { kind: 'sleep'; id: string }

export type SessionRoute = { kind: 'collection' } | SessionItemRoute

const SHELL_ACTIONS = new Set<string>(['output', 'kill', 'agent-write'])

// Whole-segment matching: `/sessionsX` is not a session path. A segment that is not valid percent-encoding is a 400,
// and an empty session id is no route at all, so `/sessions//permissions/x` can never reach the collection.
export function parseSessionRoute(basePath: string, url: string): SessionRoute | null {
  const pathname = new URL(url, 'http://internal').pathname
  const prefix = basePath + '/sessions'
  if (pathname !== prefix && !pathname.startsWith(prefix + '/')) {
    return null
  }
  const rest = pathname.slice(prefix.length)
  if (rest === '' || rest === '/') {
    return { kind: 'collection' }
  }
  const parts = rest.slice(1).split('/')
  if (parts[0] === '') {
    return null
  }
  return itemRoute(parts[0]!, parts)
}

function itemRoute(rawId: string, parts: string[]): SessionItemRoute | null {
  const [, section, third, fourth] = parts
  const length = parts.length
  if (length === 1) {
    return { kind: 'session', id: decode(rawId) }
  }
  if (length === 2 && section === 'ws') {
    return { kind: 'ws', id: decode(rawId) }
  }
  if (length === 3 && section === 'permissions') {
    const permissionId = decode(third!)
    return permissionId === '' ? null : { kind: 'permission', id: decode(rawId), permissionId }
  }
  if (length <= 3 && section === 'attachments') {
    return { kind: 'attachments', id: decode(rawId), attachmentId: optional(third) }
  }
  if (length <= 3 && section === 'produced') {
    return { kind: 'produced', id: decode(rawId), producedFileId: optional(third) }
  }
  if (section === 'shells' && length <= 4) {
    if (fourth !== undefined && !SHELL_ACTIONS.has(fourth)) {
      return null
    }
    return { kind: 'shells', id: decode(rawId), shellId: optional(third), shellAction: fourth as ShellRouteAction | undefined }
  }
  if (length === 4 && section === 'tasks' && fourth === 'stop') {
    return { kind: 'stop-task', id: decode(rawId), stopTaskId: decode(third!) }
  }
  if (length === 3 && section === 'tasks' && third === 'background') {
    return { kind: 'background-task', id: decode(rawId) }
  }
  if (length === 4 && section === 'tasks' && fourth === 'background') {
    return { kind: 'background-task', id: decode(rawId), backgroundTaskId: decode(third!) }
  }
  if (length === 3 && section === 'project' && third === 'icon') {
    return { kind: 'project-icon', id: decode(rawId) }
  }
  if (length === 4 && section === 'events' && fourth === 'result') {
    const seq = Number(third)
    return Number.isInteger(seq) && seq >= 0 ? { kind: 'tool-result', id: decode(rawId), resultSeq: seq } : null
  }
  if (length === 2 && section === 'sleep') {
    return { kind: 'sleep', id: decode(rawId) }
  }
  if (length === 2 && section === 'peers') {
    return { kind: 'peers', id: decode(rawId) }
  }
  if (length <= 3 && section === 'mcp') {
    // MCP server names are opaque and may contain ':' (plugin:gtm:gtm) - one segment, decoded whole.
    return { kind: 'mcp', id: decode(rawId), mcpServer: optional(third) }
  }
  if (length >= 2 && section === 'files') {
    const filePath = parts.slice(2).map(decode).join('/')
    return { kind: 'files', id: decode(rawId), filePath: filePath === '' ? undefined : '/' + filePath }
  }
  return null
}

function optional(segment: string | undefined): string | undefined {
  return segment === undefined ? undefined : decode(segment)
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, 'malformed percent-encoding in path')
  }
}
