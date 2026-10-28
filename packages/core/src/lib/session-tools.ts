import {
  CONTEXT_RESET_TOOL,
  CONTEXT_RESET_TOOL_SHAPE,
  isContextResetToolName,
  runContextResetTool,
  type ContextResetDirectory,
} from './context-reset.ts'
import { gatewayToolSpec, type GatewayToolOutput, type GatewayToolShape, type GatewayToolSpec } from './gateway-tools.ts'
import {
  SESSION_INFO_TOOL,
  SESSION_INFO_TOOL_SHAPE,
  isSessionInfoToolName,
  runSessionInfoTool,
  type SessionReportSource,
} from './session-report.ts'
import { CHANGE_AVATAR_TOOL, CHANGE_AVATAR_TOOL_SHAPE, isChangeAvatarToolName, runChangeAvatarTool, type AvatarDirectory } from './avatar-tool.ts'
import { SET_STATUS_TOOL, SET_STATUS_TOOL_SHAPE, isSetStatusToolName, runSetStatusTool, type StatusLabelSink } from './status-label.ts'
import { PEER_TOOL_NAMES, PEER_TOOL_SHAPES, isPeerToolName, runPeerTool, type PeerDirectory } from './peers.ts'
import { SHELL_TOOL_SHAPES, isShellToolName, runShellTool, shellToolNames, type ShellDirectory } from './shells.ts'

export type SessionToolSources = {
  report?: SessionReportSource
  status?: StatusLabelSink
  avatar?: AvatarDirectory
  reset?: ContextResetDirectory
  peers?: PeerDirectory
  shells?: ShellDirectory
  write: boolean
}

export type SessionTool = GatewayToolShape & { name: string; run(args: unknown): Promise<GatewayToolOutput> }

// The gateway's own tools a session is offered, session_info, set_status, change_avatar, context_reset, peers, shells: the order every engine
// registers them in.
export function sessionTools(sources: SessionToolSources, from: () => string): SessionTool[] {
  const { report, status, avatar, reset, peers, shells, write } = sources
  return [
    ...(report ? [{ name: SESSION_INFO_TOOL, ...SESSION_INFO_TOOL_SHAPE, run: () => runSessionInfoTool(report, from()) }] : []),
    ...(status ? [{ name: SET_STATUS_TOOL, ...SET_STATUS_TOOL_SHAPE, run: (args: unknown) => runSetStatusTool(status, from(), args) }] : []),
    ...(avatar
      ? [{ name: CHANGE_AVATAR_TOOL, ...CHANGE_AVATAR_TOOL_SHAPE, run: (args: unknown) => runChangeAvatarTool(avatar, from(), args) }]
      : []),
    ...(reset
      ? [{ name: CONTEXT_RESET_TOOL, ...CONTEXT_RESET_TOOL_SHAPE, run: (args: unknown) => runContextResetTool(reset, from(), args) }]
      : []),
    ...(peers
      ? PEER_TOOL_NAMES.map((name) => ({ name, ...PEER_TOOL_SHAPES[name], run: (args: unknown) => runPeerTool(peers, from(), name, args) }))
      : []),
    ...(shells
      ? shellToolNames(write).map((name) => ({
          name,
          ...SHELL_TOOL_SHAPES[name],
          run: (args: unknown) => runShellTool(shells, from(), name, args, { write }),
        }))
      : []),
  ]
}

export function sessionToolSpecs(sources: SessionToolSources): GatewayToolSpec[] {
  return sessionTools(sources, () => '').map((tool) => gatewayToolSpec(tool.name, tool))
}

// By name rather than by offer, so a write tool the session does not hold answers with the refusal, not as unknown.
export function runSessionTool(
  sources: SessionToolSources,
  from: string,
  name: string,
  args: unknown,
): Promise<GatewayToolOutput> | undefined {
  if (sources.report && isSessionInfoToolName(name)) {
    return runSessionInfoTool(sources.report, from)
  }
  if (sources.status && isSetStatusToolName(name)) {
    return runSetStatusTool(sources.status, from, args)
  }
  if (sources.avatar && isChangeAvatarToolName(name)) {
    return runChangeAvatarTool(sources.avatar, from, args)
  }
  if (sources.reset && isContextResetToolName(name)) {
    return runContextResetTool(sources.reset, from, args)
  }
  if (sources.peers && isPeerToolName(name)) {
    return runPeerTool(sources.peers, from, name, args)
  }
  if (sources.shells && isShellToolName(name)) {
    return runShellTool(sources.shells, from, name, args, { write: sources.write })
  }
  return undefined
}
