import { errorMessage, type McpServerStatusInfo } from '@workerdeck/protocol'
import { z } from 'zod'
import { defineToolFamily, type GatewayToolOutput } from './gateway-tools.ts'

export type McpControl = {
  list(): Promise<McpServerStatusInfo[] | undefined>
  reconnect(name: string): Promise<void>
  reload?(): void
}

export const MCP_RECONNECT_TOOL = 'mcp_reconnect'
export const MCP_RELOAD_TOOL = 'mcp_reload'

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
  [MCP_RELOAD_TOOL]: {
    description:
      'Reload your MCP server configuration, for a server that was added, removed or changed after your engine started ' +
      '(for example with `claude mcp add`). Your engine restarts on this same conversation once the current turn ends ' +
      'and reads its configuration afresh; the new servers\' tools are available from the next message, not in this ' +
      'turn. Call it, tell the human, and end your turn. For a configured server that is only failed or disconnected, ' +
      'use `mcp_reconnect` instead.',
    shape: {},
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
  [MCP_RELOAD_TOOL]: async (control) => {
    if (!control.reload) {
      return { text: 'This session cannot reload its MCP configuration.', isError: true }
    }
    control.reload()
    return {
      text:
        'MCP reload scheduled: your engine restarts on this conversation when this turn ends, and the reloaded ' +
        'servers are available from the next message. End your turn now.',
      isError: false,
    }
  },
})

export const MCP_TOOL_SHAPE = MCP_TOOL_SHAPES

export type McpToolName = keyof typeof MCP_TOOL_SHAPES

export function mcpToolNames(control: McpControl): McpToolName[] {
  return control.reload ? [MCP_RECONNECT_TOOL, MCP_RELOAD_TOOL] : [MCP_RECONNECT_TOOL]
}

export function isMcpToolName(name: string): name is McpToolName {
  return MCP_TOOLS.is(name)
}

export function runMcpTool(control: McpControl, from: string, name: McpToolName, args: unknown): Promise<GatewayToolOutput> {
  return MCP_TOOLS.run(control, from, name, args)
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
