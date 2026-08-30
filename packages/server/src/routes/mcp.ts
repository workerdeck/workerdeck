/**
 * `{basePath}/sessions/:id/mcp` — the session's MCP servers (reconnect, enable, disable).
 *
 * Every answer goes through `mcpStatusInfo`, which drops the servers' `env` and
 * `headers`: reading this route must not be a way to read the operator's API tokens.
 */
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
    // Checked before dispatching, because the calls below are optionally chained: an engine
    // that lists its servers but cannot act on one (codex) would no-op and answer 200 with
    // the unchanged list.
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
      // The CLI's own message ("No MCP server found named x") is the useful one.
      json(res, 400, { error: error instanceof Error ? error.message : 'MCP action failed' })
      return
    }
    await listServers()
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
