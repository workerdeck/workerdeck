import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { createVfs, type SandboxVfs } from '@workerdeck/sandbox'
import type { ToolExecutionResult, ToolExecutor } from '../../executors/tool-executor.ts'
import type { WebFetchFn } from './web-fetch.ts'

export type ToolTrust = 'sandboxed' | 'authoritative'

export type ToolDefinition = {
  name: string
  trust: ToolTrust
  tool: Tool
}

export type ToolContextOptions = {
  executor: ToolExecutor
  sessionId: string
  vfs?: SandboxVfs
  search?: (query: string, limit: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>
  download?: (url: string) => Promise<{ contentType?: string; text: string }>
  webFetch?: WebFetchFn
  onFileDelivered?: (file: { path: string; bytes: number; description?: string }) => void
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  onDispatch?: (executionId: string, toolName: string) => void
  onSettle?: (executionId: string, result: ToolExecutionResult) => void
}

export type ToolContext = {
  vfs: SandboxVfs
  tools: ToolSet
  definitions: ToolDefinition[]
  sandboxedToolNames: string[]
}

const MAX_FILE_BYTES = 1024 * 1024

export const createToolContext = (options: ToolContextOptions): ToolContext => {
  const vfs = options.vfs ?? createVfs()
  const definitions: ToolDefinition[] = []

  definitions.push({
    name: 'fs_list',
    trust: 'authoritative',
    tool: tool({
      description: 'List files in the scratch filesystem.',
      inputSchema: z.object({ dir: z.string().default('/').describe('Directory to list') }),
      execute: async ({ dir }) => ({ files: vfs.list(dir) }),
    }),
  })
  definitions.push({
    name: 'fs_read',
    trust: 'authoritative',
    tool: tool({
      description: 'Read a file from the scratch filesystem.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const content = vfs.read(path)
        if (content === undefined) {
          return { error: `no such file: ${path}` }
        }
        return { content: truncate(content) }
      },
    }),
  })
  definitions.push({
    name: 'fs_write',
    trust: 'authoritative',
    tool: tool({
      description: 'Write a file to the scratch filesystem.',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ path, content }) => {
        vfs.write(path, content)
        return { path, bytes: content.length }
      },
    }),
  })

  if (options.onFileDelivered) {
    const onFileDelivered = options.onFileDelivered
    definitions.push({
      name: 'deliver_file',
      trust: 'authoritative',
      tool: tool({
        description:
          'Hand a file from the scratch filesystem over to the user as a deliverable. Write it with fs_write first, then deliver it.',
        inputSchema: z.object({
          path: z.string().describe('Path of an existing file in the scratch filesystem'),
          description: z.string().optional().describe('What this file is, for the recipient'),
        }),
        execute: async ({ path, description }) => {
          const content = vfs.read(path)
          if (content === undefined) {
            return { error: `no such file: ${path}` }
          }
          const file = { path, bytes: content.length, description }
          onFileDelivered(file)
          return { delivered: true, ...file }
        },
      }),
    })
  }

  if (options.search) {
    const search = options.search
    definitions.push({
      name: 'web_search',
      trust: 'authoritative',
      tool: tool({
        description: 'Search the web for pages relevant to a query.',
        inputSchema: z.object({
          query: z.string(),
          limit: z.number().int().min(1).max(25).default(5),
        }),
        execute: async ({ query, limit }) => ({ results: await search(query, limit) }),
      }),
    })
  }
  if (options.download) {
    const download = options.download
    definitions.push({
      name: 'download',
      trust: 'authoritative',
      tool: tool({
        description: 'Fetch a URL and store its text in the scratch filesystem for later evaluation.',
        inputSchema: z.object({
          url: z.string().describe('Absolute http(s) URL'),
          path: z.string().describe('Where to store it in the scratch filesystem'),
        }),
        execute: async ({ url, path }) => {
          try {
            const { text, contentType } = await download(url)
            const stored = truncate(text)
            vfs.write(path, stored)
            return { path, bytes: stored.length, contentType }
          } catch (error) {
            // A failed fetch is data the agent can react to, not a turn-ending throw.
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    })
  }

  if (options.webFetch) {
    const webFetch = options.webFetch
    definitions.push({
      name: 'web_fetch',
      trust: 'authoritative',
      tool: tool({
        description:
          'Fetch a web page and process its content against a prompt. Returns the answer ' +
          '(or the page as markdown). Distinct from download: use web_fetch to answer a ' +
          'question about a page, download to store raw text for eval_script.',
        inputSchema: z.object({
          url: z.string().describe('Absolute http(s) URL'),
          prompt: z.string().describe('What to extract or answer from the page'),
        }),
        execute: async ({ url, prompt }) => {
          try {
            return await webFetch(url, prompt)
          } catch (error) {
            // A failed fetch is data the agent can react to, not a turn-ending throw.
            return { error: error instanceof Error ? error.message : String(error) }
          }
        },
      }),
    })
  }

  definitions.push({
    name: 'eval_script',
    trust: 'sandboxed',
    tool: tool({
      description:
        'Evaluate a JavaScript snippet in a sandbox to parse, score, or extract from files. ' +
        'Globals: vfs.read(path), vfs.write(path, text), vfs.list(dir), console.log. ' +
        'The value of the last expression is returned. No network or host access.',
      inputSchema: z.object({ script: z.string() }),
    }),
  })

  const tools: ToolSet = {}
  for (const definition of definitions) {
    tools[definition.name] = definition.tool
  }

  return {
    vfs,
    tools,
    definitions,
    sandboxedToolNames: definitions.filter((d) => d.trust === 'sandboxed').map((d) => d.name),
  }
}

export const withMcpTools = (context: ToolContext, mcpTools: ToolSet): ToolContext => {
  return withHostTools(
    context,
    Object.fromEntries(Object.entries(mcpTools).map(([name, mcpTool]) => [name, { tool: mcpTool, trust: 'authoritative' as const }])),
    'MCP tool',
  )
}

export type HostToolDefinition = {
  tool: Tool
  trust: ToolTrust
}

export const withHostTools = (context: ToolContext, hostTools: Record<string, HostToolDefinition>, kind = 'host tool'): ToolContext => {
  const entries = Object.entries(hostTools)
  if (entries.length === 0) {
    return context
  }
  const definitions = [...context.definitions]
  const tools: ToolSet = { ...context.tools }
  const sandboxedToolNames = [...context.sandboxedToolNames]
  for (const [name, { tool: hostTool, trust }] of entries) {
    if (name in tools) {
      // A collision would let a host tool shadow `eval_script`, or an MCP name promote untrusted
      // execution to authoritative.
      throw new Error(`${kind} '${name}' collides with an existing tool of the same name`)
    }
    const executes = typeof (hostTool as { execute?: unknown }).execute === 'function'
    if (trust === 'sandboxed' && executes) {
      throw new Error(
        `${kind} '${name}' is declared sandboxed but has an \`execute\` — it would run in ` +
          'this process with full authority. Drop `execute` so it rides the ToolExecutor seam.',
      )
    }
    if (trust === 'authoritative' && !executes) {
      throw new Error(
        `${kind} '${name}' is declared authoritative but has no \`execute\` — nothing would ` +
          'ever answer its calls and the turn would stall.',
      )
    }
    definitions.push({ name, trust, tool: hostTool })
    tools[name] = hostTool
    if (trust === 'sandboxed') {
      sandboxedToolNames.push(name)
    }
  }
  return { ...context, tools, definitions, sandboxedToolNames }
}

const truncate = (text: string): string => {
  return text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text
}
