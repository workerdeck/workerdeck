import { canSleep, clearContextOffered, type SessionInfo } from '@workerdeck/protocol'

export const SESSION_ACTIONS = [
  'stop',
  'moveToPanel',
  'openInEditor',
  'setStatus',
  'newConversation',
  'sleep',
  'makeAgent',
  'leaveTeam',
  'addToTeam',
  'dissolveTeam',
  'makePrivate',
  'share',
  'changeAvatar',
  'editSettings',
  'editBrief',
  'conversations',
  'deleteAgent',
  'delete',
] as const

export type SessionAction = (typeof SESSION_ACTIONS)[number]

export function sessionActionCommand(action: SessionAction | 'more'): string {
  return `workerdeck.session.${action}`
}

export type SessionMenuContext = { hostId: string; sessionId: string }

export function teamLeadsFor(sessions: readonly SessionInfo[], info: SessionInfo): SessionInfo[] {
  const agent = info.agent
  return sessions.filter((s) => s.agent && s.agent.lead === undefined && s.agent.id !== agent?.id && s.id !== info.id)
}

export function sessionActions(info: SessionInfo, at: { surface?: 'editor' | 'panel'; hasLeads: boolean }): SessionAction[] {
  const agent = info.agent
  const actions: SessionAction[] = []
  if (info.status === 'running' || info.status === 'starting') {
    actions.push('stop')
  }
  actions.push(at.surface === 'editor' ? 'moveToPanel' : 'openInEditor', 'setStatus')
  if (clearContextOffered(info)) {
    actions.push('newConversation')
  }
  if (canSleep(info)) {
    actions.push('sleep')
  }
  if (!agent) {
    actions.push('makeAgent')
  }
  if (agent?.lead !== undefined) {
    actions.push('leaveTeam')
  } else if (!agent?.leads && at.hasLeads) {
    actions.push('addToTeam')
  }
  if (agent?.leads) {
    actions.push('dissolveTeam')
  }
  if (agent && agent.lead === undefined) {
    actions.push(agent.shared ? 'makePrivate' : 'share')
  }
  if (agent) {
    actions.push('changeAvatar')
  }
  if (agent) {
    actions.push('editSettings', 'editBrief')
  }
  actions.push('conversations', agent ? 'deleteAgent' : 'delete')
  return actions
}

export function sessionMenuContext(info: SessionInfo, hostId: string, at: { surface?: 'editor' | 'panel'; hasLeads: boolean }): string {
  const flags = Object.fromEntries(sessionActions(info, at).map((action) => [`wd_${action}`, true]))
  return JSON.stringify({ webviewSection: 'session', hostId, sessionId: info.id, preventDefaultContextMenuItems: true, ...flags })
}
