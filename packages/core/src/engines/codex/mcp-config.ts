import type { CreateSessionRequest, McpServerConfigWire } from '@workerdeck/protocol'

type McpFilterInput = Pick<CreateSessionRequest, 'mcpServers' | 'allowedTools' | 'disallowedTools'>

type CodexMcpServer = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  http_headers?: Record<string, string>
  enabled?: boolean
  disabled_tools?: string[]
  default_tools_approval_mode?: 'approve'
  tools?: Record<string, { approval_mode: 'approve' }>
}

type McpToolName = { server: string; tool?: string }

const SERVER_NAME = /^[A-Za-z0-9_-]+$/

export function refuseCodexMcpServers(servers: Record<string, McpServerConfigWire> | undefined): string | null {
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (!SERVER_NAME.test(name)) {
      return `codex MCP server names may use only letters, digits, '_' and '-': '${name}'`
    }
    if (server.type === 'sse') {
      return `the codex engine has no SSE MCP transport ('${name}'): use type 'http' (streamable HTTP) or stdio`
    }
  }
  return null
}

export function parseMcpToolName(name: string): McpToolName | undefined {
  if (!name.startsWith('mcp__')) {
    return undefined
  }
  const rest = name.slice('mcp__'.length)
  const split = rest.indexOf('__')
  if (split < 0) {
    return rest ? { server: rest } : undefined
  }
  const server = rest.slice(0, split)
  const tool = rest.slice(split + 2)
  if (!server) {
    return undefined
  }
  return tool && tool !== '*' ? { server, tool } : { server }
}

// Filter entries naming a server the request does not declare; the runner must learn whether config.toml has it.
export function undeclaredFilterServers(config: McpFilterInput): string[] {
  const declared = new Set(Object.keys(config.mcpServers ?? {}))
  const named = [...(config.allowedTools ?? []), ...(config.disallowedTools ?? [])].flatMap(
    (entry) => parseMcpToolName(entry)?.server ?? [],
  )
  return [...new Set(named)].filter((server) => !declared.has(server))
}

// `known`: config.toml servers. A filter-only entry for a server codex does not know fails thread/start, so it drops.
export function codexMcpServers(
  config: McpFilterInput,
  known: ReadonlySet<string> = new Set(),
): Record<string, CodexMcpServer> | undefined {
  const servers: Record<string, CodexMcpServer> = {}
  for (const [name, wire] of Object.entries(config.mcpServers ?? {})) {
    servers[name] = codexServer(wire)
  }
  const entryFor = (server: string): CodexMcpServer | undefined => {
    if (!servers[server] && known.has(server)) {
      servers[server] = {}
    }
    return servers[server]
  }
  for (const entry of config.allowedTools ?? []) {
    const parsed = parseMcpToolName(entry)
    const server = parsed && entryFor(parsed.server)
    if (!parsed || !server) {
      continue
    }
    if (parsed.tool) {
      server.tools = { ...server.tools, [parsed.tool]: { approval_mode: 'approve' } }
    } else {
      server.default_tools_approval_mode = 'approve'
    }
  }
  for (const entry of config.disallowedTools ?? []) {
    const parsed = parseMcpToolName(entry)
    const server = parsed && entryFor(parsed.server)
    if (!parsed || !server) {
      continue
    }
    if (parsed.tool) {
      server.disabled_tools = [...(server.disabled_tools ?? []), parsed.tool]
    } else if (config.mcpServers?.[parsed.server]) {
      delete servers[parsed.server]
    } else {
      servers[parsed.server] = { enabled: false }
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined
}

function codexServer(wire: McpServerConfigWire): CodexMcpServer {
  if (wire.type === 'http' || wire.type === 'sse') {
    return { url: wire.url, ...(wire.headers ? { http_headers: wire.headers } : {}) }
  }
  return { command: wire.command, ...(wire.args ? { args: wire.args } : {}), ...(wire.env ? { env: wire.env } : {}) }
}
