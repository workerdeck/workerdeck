import { errorMessage, type McpServerStatusInfo } from '@workerdeck/protocol'
import { z } from 'zod'
import { defineToolFamily, type GatewayToolOutput } from './gateway-tools.ts'

export type McpControl = {
  list(): Promise<McpServerStatusInfo[] | undefined>
  reconnect(name: string): Promise<void>
}

export const MCP_RECONNECT_TOOL = 'mcp_reconnect'

// `needs-auth` waits on the human and `disabled` was a choice, so neither is healed unasked.
export function mcpNeedsReconnect(server: McpServerStatusInfo): boolean {
  return server.status === 'failed'
}

const MCP_TOOL_SHAPES = {
  [MCP_RECONNECT_TOOL]: {
    description:
      'Reconnect your MCP servers. Use it when an MCP server shows as failed or disconnected, or an MCP tool you expected ' +
      'is missing, for example because the server was started after you were. Without `server` it reconnects every ' +
      'failed server; with `server` it reconnects that one whatever its state. Returns every server\'s state afterwards; ' +
      'a server that reconnected offers its tools from your next step on.',
    shape: {
      server: z.string().min(1).optional().describe('The server name to reconnect; omit to reconnect every failed server'),
    },
  },
} as const

const MCP_TOOLS = defineToolFamily<typeof MCP_TOOL_SHAPES, McpControl>(MCP_TOOL_SHAPES, {
  [MCP_RECONNECT_TOOL]: async (control, _from, input) => {
    const before = await control.list()
    if (!before) {
      return { text: 'This session does not report its MCP servers.', isError: true }
    }
    if (input.server !== undefined && !before.some((server) => server.name === input.server)) {
      return { text: `No MCP server named "${input.server}". ${statusLines(before)}`, isError: true }
    }
    const targets = input.server === undefined ? before.filter(mcpNeedsReconnect).map((server) => server.name) : [input.server]
    if (targets.length === 0) {
      return { text: `No MCP server needed reconnecting.\n${statusLines(before)}`, isError: false }
    }
    const failures = await reconnectAll((name) => control.reconnect(name), targets)
    const after = (await control.list()) ?? before
    const head = failures.length
      ? `Reconnect failed for ${failures.map(({ name, error }) => `${name} (${error})`).join(', ')}.`
      : `Reconnected ${targets.join(', ')}.`
    return { text: `${head}\n${statusLines(after)}`, isError: failures.length === targets.length }
  },
})

export const MCP_RECONNECT_TOOL_SHAPE = MCP_TOOL_SHAPES[MCP_RECONNECT_TOOL]

export function isMcpToolName(name: string): name is typeof MCP_RECONNECT_TOOL {
  return MCP_TOOLS.is(name)
}

export function runMcpTool(control: McpControl, from: string, args: unknown): Promise<GatewayToolOutput> {
  return MCP_TOOLS.run(control, from, MCP_RECONNECT_TOOL, args)
}

export async function reconnectAll(
  reconnect: (name: string) => Promise<void>,
  names: readonly string[],
): Promise<{ name: string; error: string }[]> {
  const failures: { name: string; error: string }[] = []
  for (const name of names) {
    try {
      await reconnect(name)
    } catch (error) {
      failures.push({ name, error: errorMessage(error) })
    }
  }
  return failures
}

function statusLines(servers: readonly McpServerStatusInfo[]): string {
  if (servers.length === 0) {
    return 'No MCP servers are configured.'
  }
  return servers.map((server) => `- ${server.name}: ${server.status}${server.error ? ` (${server.error})` : ''}`).join('\n')
}
