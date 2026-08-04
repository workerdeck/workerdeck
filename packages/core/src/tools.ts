import { tool, type Tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { createVfs, type SandboxVfs } from '@workerdeck/sandbox'
import type { ToolExecutionResult, ToolExecutor } from './tool-executor.ts'
import type { WebFetchFn } from './web-fetch.ts'

/**
 * How much authority a tool carries, which decides where it may run.
 *
 * - `sandboxed` — no ambient authority; safe to execute anywhere, including an
 *   untrusted browser tab. Its results are untrusted input.
 * - `authoritative` — runs server-side with server credentials (MCP, secret-bearing
 *   APIs). **Never bridged to a client**: bridging it would hand a browser the
 *   ability to forge authoritative results.
 */
export type ToolTrust = 'sandboxed' | 'authoritative'

export type ToolDefinition = {
  name: string
  trust: ToolTrust
  /** The AI SDK tool. Sandboxed tools are declared WITHOUT `execute` so the loop
   * hands them to the ToolExecutor seam rather than running them inline. */
  tool: Tool
}

export type ToolContextOptions = {
  /** Executor for sandboxed tools. Selected per call by the host (browser bridge
   * when a client is attached, server QuickJS otherwise). */
  executor: ToolExecutor
  sessionId: string
  /** Scratch filesystem shared by this session's sandboxed tools. */
  vfs?: SandboxVfs
  /** Search backend. Omitted = `web_search` is not granted at all. */
  search?: (query: string, limit: number) => Promise<Array<{ title: string; url: string; snippet?: string }>>
  /** Document fetcher for `download`. Omitted = the tool is not granted. */
  download?: (url: string) => Promise<{ contentType?: string; text: string }>
  /** Page digester for `web_fetch` (see {@link createWebFetch}). Omitted = the
   * tool is not granted. */
  webFetch?: WebFetchFn
  /** Notified when the agent hands over a VFS file via `deliver_file`, so the
   * host can emit the `file_delivered` session event. The tool is only granted
   * when this is set — a delivery nobody hears is not a delivery. */
  onFileDelivered?: (file: { path: string; bytes: number; description?: string }) => void
  /** Per-call sandbox limits. */
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  /** Notified when a sandboxed execution is dispatched and when it settles, so
   * the host can emit execution_* events. */
  onDispatch?: (executionId: string, toolName: string) => void
  onSettle?: (executionId: string, result: ToolExecutionResult) => void
}

/** Everything a session's tools need, plus the tool set to hand the runner. */
export type ToolContext = {
  vfs: SandboxVfs
  tools: ToolSet
  definitions: ToolDefinition[]
  /** Names the loop must not execute inline (they go through the executor). */
  sandboxedToolNames: string[]
}

const MAX_FILE_BYTES = 1024 * 1024

/**
 * Build the capability-scoped tool set for a session.
 *
 * The agent's authority is exactly what is granted here — there are no built-in
 * filesystem or shell tools, and nothing reaches the host filesystem: `fs_*`
 * operate on an in-memory scratch VFS. Tools whose backend is not supplied are
 * simply absent rather than present-and-failing, so a model cannot be tempted
 * by a capability the operator did not grant.
 */
export function createToolContext(options: ToolContextOptions): ToolContext {
  const vfs = options.vfs ?? createVfs()
  const definitions: ToolDefinition[] = []

  // --- Scratch filesystem (server-side, in-memory; never the host disk) -----
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
        if (content === undefined) return { error: `no such file: ${path}` }
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

  // --- File hand-over: only when the host listens for deliveries ------------
  if (options.onFileDelivered) {
    const onFileDelivered = options.onFileDelivered
    definitions.push({
      name: 'deliver_file',
      trust: 'authoritative',
      tool: tool({
        description:
          'Hand a file from the scratch filesystem over to the user as a deliverable. ' +
          'Write it with fs_write first, then deliver it.',
        inputSchema: z.object({
          path: z.string().describe('Path of an existing file in the scratch filesystem'),
          description: z.string().optional().describe('What this file is, for the recipient'),
        }),
        execute: async ({ path, description }) => {
          const content = vfs.read(path)
          if (content === undefined) return { error: `no such file: ${path}` }
          const file = { path, bytes: content.length, description }
          onFileDelivered(file)
          return { delivered: true, ...file }
        },
      }),
    })
  }

  // --- Network capabilities: only when the host supplied a backend ----------
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
        description:
          'Fetch a URL and store its text in the scratch filesystem for later evaluation.',
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

  // --- Untrusted evaluation: no `execute`, so it rides the executor seam ----
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
  for (const definition of definitions) tools[definition.name] = definition.tool

  return {
    vfs,
    tools,
    definitions,
    sandboxedToolNames: definitions.filter((d) => d.trust === 'sandboxed').map((d) => d.name),
  }
}

/** Add host-side MCP tools to a context. They are ALWAYS authoritative: they run
 * server-side with server credentials, and must never be handed to a browser. */
export function withMcpTools(context: ToolContext, mcpTools: ToolSet): ToolContext {
  const definitions = [...context.definitions]
  const tools: ToolSet = { ...context.tools }
  for (const [name, mcpTool] of Object.entries(mcpTools)) {
    if (context.sandboxedToolNames.includes(name)) {
      // A sandboxed name colliding with an MCP name would silently promote
      // untrusted execution to authoritative — refuse rather than guess.
      throw new Error(`MCP tool '${name}' collides with a sandboxed tool of the same name`)
    }
    definitions.push({ name, trust: 'authoritative', tool: mcpTool })
    tools[name] = mcpTool
  }
  return { ...context, tools, definitions }
}

function truncate(text: string): string {
  return text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text
}
