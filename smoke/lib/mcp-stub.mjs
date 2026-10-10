// A minimal stdio MCP server: `<name>_ping` answers `pong from <name> <marker>`, `<name>_other` exists to be filtered.
import { createInterface } from 'node:readline'

const name = process.argv[2] ?? 'stub'
const marker = process.argv[3] ?? 'no-marker'

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version: '1' } },
    })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [tool('ping'), tool('other')] } })
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `pong from ${name} ${marker}` }] } })
  } else if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
  }
})

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function tool(suffix) {
  return { name: `${name}_${suffix}`, description: `${suffix} probe`, inputSchema: { type: 'object', properties: {} } }
}
