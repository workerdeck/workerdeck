import { describe, expect, it } from 'vitest'
import { codexMcpServers, parseMcpToolName, refuseCodexMcpServers, undeclaredFilterServers } from '../src/engines/codex/mcp-config.ts'

describe('codex per-session MCP config', () => {
  it('maps stdio and streamable HTTP servers onto codex config keys', () => {
    expect(
      codexMcpServers({
        mcpServers: {
          local: { command: 'node', args: ['stub.mjs'], env: { A: '1' } },
          bare: { type: 'stdio', command: 'tool' },
          remote: { type: 'http', url: 'https://x/mcp', headers: { 'x-toolset': 'sales' } },
        },
      }),
    ).toEqual({
      local: { command: 'node', args: ['stub.mjs'], env: { A: '1' } },
      bare: { command: 'tool' },
      remote: { url: 'https://x/mcp', http_headers: { 'x-toolset': 'sales' } },
    })
  })

  it('returns nothing when there is nothing to override', () => {
    expect(codexMcpServers({})).toBeUndefined()
    expect(codexMcpServers({ allowedTools: ['mcp__nowhere__x'] })).toBeUndefined()
  })

  it('turns allowedTools into auto-approval and disallowedTools into removal', () => {
    expect(
      codexMcpServers({
        mcpServers: { a: { command: 'a' }, b: { command: 'b' } },
        allowedTools: ['mcp__a__ping', 'mcp__b'],
        disallowedTools: ['mcp__a__drop', 'mcp__a__wipe'],
      }),
    ).toEqual({
      a: { command: 'a', tools: { ping: { approval_mode: 'approve' } }, disabled_tools: ['drop', 'wipe'] },
      b: { command: 'b', default_tools_approval_mode: 'approve' },
    })
  })

  it('drops a declared server disallowed whole, and switches a config.toml one off', () => {
    expect(
      codexMcpServers(
        { mcpServers: { a: { command: 'a' }, b: { command: 'b' } }, disallowedTools: ['mcp__a', 'mcp__gamma', 'mcp__a__x'] },
        new Set(['gamma']),
      ),
    ).toEqual({ b: { command: 'b' }, gamma: { enabled: false } })
  })

  it('filters config.toml servers only when codex knows them, since a bare entry fails thread/start', () => {
    const config = { allowedTools: ['mcp__gamma__ping'], disallowedTools: ['mcp__gamma__other', 'mcp__delta__x'] }
    expect(undeclaredFilterServers(config)).toEqual(['gamma', 'delta'])
    expect(codexMcpServers(config, new Set(['gamma']))).toEqual({
      gamma: { tools: { ping: { approval_mode: 'approve' } }, disabled_tools: ['other'] },
    })
  })

  it('ignores names that are not MCP tools', () => {
    expect(codexMcpServers({ mcpServers: { a: { command: 'a' } }, allowedTools: ['Bash'], disallowedTools: ['mcp__'] })).toEqual({
      a: { command: 'a' },
    })
  })

  it('parses mcp__server__tool, a bare server and a wildcard', () => {
    expect(parseMcpToolName('mcp__srv__do_thing')).toEqual({ server: 'srv', tool: 'do_thing' })
    expect(parseMcpToolName('mcp__srv')).toEqual({ server: 'srv' })
    expect(parseMcpToolName('mcp__srv__*')).toEqual({ server: 'srv' })
    expect(parseMcpToolName('Bash')).toBeUndefined()
  })

  it('refuses SSE and names codex silently starves of tools', () => {
    expect(refuseCodexMcpServers({ ok_name: { command: 'x' }, 'also-ok': { type: 'http', url: 'u' } })).toBeNull()
    expect(refuseCodexMcpServers({ s: { type: 'sse', url: 'u' } })).toMatch(/SSE/)
    expect(refuseCodexMcpServers({ 'two words': { command: 'x' } })).toMatch(/names/)
    expect(refuseCodexMcpServers(undefined)).toBeNull()
  })
})
