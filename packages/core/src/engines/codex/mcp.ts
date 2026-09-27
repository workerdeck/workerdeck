import type { McpServerStatusInfo } from '@workerdeck/protocol'
import type { AppServerMcpServerStatus } from './types.ts'

export type McpStartupStatus = { status: string; error?: string; failureReason?: string }

export function mcpServerInfo(server: AppServerMcpServerStatus, update: McpStartupStatus | undefined): McpServerStatusInfo {
  const tools = Object.entries(server.tools ?? {}).flatMap(([key, tool]) => {
    if (!tool) {
      return []
    }
    const annotations = tool.annotations
    return [
      {
        name: tool.name ?? key,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        ...(annotations
          ? {
              annotations: {
                ...(annotations.readOnlyHint != null ? { readOnly: annotations.readOnlyHint } : {}),
                ...(annotations.destructiveHint != null ? { destructive: annotations.destructiveHint } : {}),
                ...(annotations.openWorldHint != null ? { openWorld: annotations.openWorldHint } : {}),
              },
            }
          : {}),
      },
    ]
  })
  return {
    name: server.name,
    status: mcpStatusOf(server.authStatus ?? undefined, update, tools.length > 0),
    ...(update?.error ? { error: update.error } : {}),
    ...(server.serverInfo?.name ? { serverInfo: { name: server.serverInfo.name, version: server.serverInfo.version ?? '' } } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

function mcpStatusOf(authStatus: string | undefined, update: McpStartupStatus | undefined, hasTools: boolean): string {
  if (update?.status === 'failed') {
    return update.failureReason === 'reauthenticationRequired' ? 'needs-auth' : 'failed'
  }
  if (update?.status === 'cancelled') {
    return 'failed'
  }
  if (authStatus === 'notLoggedIn') {
    return 'needs-auth'
  }
  if (update?.status === 'ready' || hasTools) {
    return 'connected'
  }
  return 'pending'
}
