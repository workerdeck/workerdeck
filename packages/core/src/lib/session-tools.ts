import { gatewayToolSpec, type GatewayToolOutput, type GatewayToolShape, type GatewayToolSpec } from './gateway-tools.ts'
import {
  SESSION_INFO_TOOL,
  SESSION_INFO_TOOL_SHAPE,
  isSessionInfoToolName,
  runSessionInfoTool,
  type SessionReportSource,
} from './session-report.ts'
import { PEER_TOOL_NAMES, PEER_TOOL_SHAPES, isPeerToolName, runPeerTool, type PeerDirectory } from './peers.ts'
import { SHELL_TOOL_SHAPES, isShellToolName, runShellTool, shellToolNames, type ShellDirectory } from './shells.ts'

export type SessionToolSources = { report?: SessionReportSource; peers?: PeerDirectory; shells?: ShellDirectory; write: boolean }

export type SessionTool = GatewayToolShape & { name: string; run(args: unknown): Promise<GatewayToolOutput> }

// The gateway's own tools a session is offered, session_info then peers then shells, in the order every engine registers them.
export function sessionTools(sources: SessionToolSources, from: () => string): SessionTool[] {
  const { report, peers, shells, write } = sources
  return [
    ...(report ? [{ name: SESSION_INFO_TOOL, ...SESSION_INFO_TOOL_SHAPE, run: () => runSessionInfoTool(report, from()) }] : []),
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
  if (sources.peers && isPeerToolName(name)) {
    return runPeerTool(sources.peers, from, name, args)
  }
  if (sources.shells && isShellToolName(name)) {
    return runShellTool(sources.shells, from, name, args, { write: sources.write })
  }
  return undefined
}
