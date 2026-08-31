import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Runner } from '@workerdeck/core'
import type { McpServerActionRequest } from '@workerdeck/protocol'
import { json, readJsonBody } from '../lib/http.ts'
import type { ServerContext } from '../context.ts'

export const handleMcp = async (
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  runner: Runner,
  serverName?: string,
): Promise<void> => {
  const listServers = async (): Promise<boolean> => {
    const servers = await runner.mcpServers?.()
    if (!servers) {
      json(res, 501, { error: 'this session does not report MCP servers' })
      return false
    }
    json(res, 200, { servers })
    return true
  }
  if (req.method === 'GET' && serverName === undefined) {
    await listServers()
    return
  }
  if (req.method === 'POST' && serverName !== undefined) {
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as McpServerActionRequest
    if (body?.action !== 'reconnect' && body?.action !== 'enable' && body?.action !== 'disable') {
      json(res, 400, { error: "action must be 'reconnect', 'enable' or 'disable'" })
      return
    }
    const canAct =
      body.action === 'reconnect' ? typeof runner.reconnectMcpServer === 'function' : typeof runner.setMcpServerEnabled === 'function'
    if (!canAct) {
      json(res, 501, {
        error: `this session's engine cannot ${body.action} an MCP server`,
      })
      return
    }
    try {
      if (body.action === 'reconnect') {
        await runner.reconnectMcpServer?.(serverName)
      } else {
        await runner.setMcpServerEnabled?.(serverName, body.action === 'enable')
      }
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'MCP action failed' })
      return
    }
    await listServers()
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
