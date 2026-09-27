import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Runner } from '@workerdeck/core'
import type { McpServerActionRequest } from '@workerdeck/protocol'
import { fail, json, readJsonBody } from '../lib/http.ts'
import type { ServerContext } from '../context.ts'

export async function handleMcp(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  runner: Runner,
  serverName?: string,
): Promise<void> {
  if (req.method === 'GET' && serverName === undefined) {
    await listServers(res, runner)
    return
  }
  if (req.method === 'POST' && serverName !== undefined) {
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as McpServerActionRequest
    if (body?.action !== 'reconnect' && body?.action !== 'enable' && body?.action !== 'disable') {
      fail(400, "action must be 'reconnect', 'enable' or 'disable'")
    }
    const canAct =
      body.action === 'reconnect' ? typeof runner.reconnectMcpServer === 'function' : typeof runner.setMcpServerEnabled === 'function'
    if (!canAct) {
      fail(501, `this session's engine cannot ${body.action} an MCP server`)
    }
    try {
      if (body.action === 'reconnect') {
        await runner.reconnectMcpServer?.(serverName)
      } else {
        await runner.setMcpServerEnabled?.(serverName, body.action === 'enable')
      }
    } catch (error) {
      fail(400, error instanceof Error ? error.message : 'MCP action failed')
    }
    await listServers(res, runner)
    return
  }
  json(res, 405, { error: 'method not allowed' })
}

async function listServers(res: ServerResponse, runner: Runner): Promise<void> {
  const servers = await runner.mcpServers?.()
  if (!servers) {
    fail(501, 'this session does not report MCP servers')
  }
  json(res, 200, { servers })
}
