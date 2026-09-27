import { describe, expect, it } from 'vitest'
import type { SessionEventBody } from '@workerdeck/protocol'
import {
  CODEX_AGENT_TOOL,
  fileProducedEvent,
  itemCompleted,
  itemContext,
  itemProgress,
  reasoningDelta,
  settleAgentTurn,
  type ItemSink,
} from '../src/engines/codex/items.ts'
import { CodexAgentTracker, type ItemScope } from '../src/engines/codex/subagents.ts'
import type { AppServerItem } from '../src/engines/codex/types.ts'

type Recorded = ItemSink & { events: SessionEventBody[]; files: string[]; final: string[] }

function sink(options: { root?: string; replaying?: boolean; partials?: boolean } = {}): Recorded {
  const events: SessionEventBody[] = []
  const files: string[] = []
  const final: string[] = []
  return {
    events,
    files,
    final,
    agents: new CodexAgentTracker(),
    model: () => 'gpt-test',
    rootThreadId: () => options.root ?? 'root',
    replaying: () => options.replaying ?? false,
    partials: () => options.partials ?? true,
    emit: (body) => events.push(body),
    fileProduced: (path, toolUseId) => files.push(`${path}@${toolUseId}`),
    finalText: (text) => final.push(text),
  }
}

function scope(nonce = 'n1'): ItemScope {
  return { nonce, toolUseEmitted: new Set(), sectionIndex: new Map() }
}

function blocks(body: SessionEventBody | undefined): unknown[] {
  return (body as { message: { content: unknown[] } }).message.content
}

describe('codex item mapping', () => {
  it('maps an agent message to an assistant text block and records the root turn text', () => {
    const s = sink()
    itemCompleted(s, { id: 'm1', type: 'agentMessage', text: 'hello' }, scope())
    expect(s.events).toEqual([
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], model: 'gpt-test' },
        parentToolUseId: null,
        uuid: 'n1:m1',
      },
    ])
    expect(s.final).toEqual(['hello'])
  })

  it('prefers the reasoning summary over its raw content', () => {
    const s = sink()
    itemCompleted(s, { id: 'r1', type: 'reasoning', summary: ['a', 'b'], content: ['raw'] }, scope())
    expect(blocks(s.events[0])).toEqual([{ type: 'thinking', thinking: 'a\n\nb' }])
  })

  it('emits a command card once across progress and completion, and flags a nonzero exit', () => {
    const s = sink()
    const sc = scope()
    const item: AppServerItem = { id: 'c1', type: 'commandExecution', command: 'ls', status: 'inProgress' }
    itemProgress(s, item, sc)
    itemProgress(s, item, sc)
    itemCompleted(s, { ...item, status: 'completed', aggregatedOutput: 'out', exitCode: 2 }, sc)

    expect(s.events.map((e) => e.type)).toEqual(['assistant_message', 'user_message'])
    expect(blocks(s.events[0])).toEqual([{ type: 'tool_use', id: 'n1:c1', name: 'CodexCommand', input: { command: 'ls' } }])
    expect(s.events[1]).toMatchObject({
      synthetic: true,
      uuid: 'n1:c1-result',
      message: { content: [{ type: 'tool_result', tool_use_id: 'n1:c1', content: 'out\n(exit code 2)', is_error: true }] },
    })
  })

  it('attaches a parsed patch to a single-file change only', () => {
    const s = sink()
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
    itemCompleted(s, { id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: 'x', kind: 'update', diff }] }, scope())
    itemCompleted(
      s,
      {
        id: 'f2',
        type: 'fileChange',
        status: 'completed',
        changes: [
          { path: 'x', kind: { type: 'add' }, diff },
          { path: 'y', kind: 'delete' },
        ],
      },
      scope(),
    )
    expect((s.events[1] as { patch?: unknown }).patch).toBeDefined()
    expect((s.events[3] as { patch?: unknown }).patch).toBeUndefined()
    expect(blocks(s.events[3])).toMatchObject([{ content: 'add: x\ndelete: y' }])
  })

  it('names an MCP call after its server and tool and reports the error text', () => {
    const s = sink()
    itemCompleted(
      s,
      {
        id: 'p1',
        type: 'mcpToolCall',
        server: 'files',
        tool: 'read',
        arguments: { path: '/a' },
        error: { message: 'nope' },
        status: 'failed',
      },
      scope(),
    )
    expect(blocks(s.events[0])).toMatchObject([{ name: 'mcp__files__read', input: { path: '/a' } }])
    expect(blocks(s.events[1])).toMatchObject([{ content: 'nope', is_error: true }])
  })

  it('re-emits an image card on completion with the saved path and reports the produced file', () => {
    const s = sink()
    const sc = scope()
    itemProgress(s, { id: 'i1', type: 'imageGeneration', status: 'inProgress', result: '' }, sc)
    itemCompleted(s, { id: 'i1', type: 'imageGeneration', status: 'completed', result: 'ok', savedPath: '/tmp/a.png' }, sc)
    const uses = s.events.filter((e) => e.type === 'assistant_message').map((e) => blocks(e)[0])
    expect(uses).toEqual([
      { type: 'tool_use', id: 'n1:i1', name: 'CodexImageGeneration', input: {} },
      { type: 'tool_use', id: 'n1:i1', name: 'CodexImageGeneration', input: { savedPath: '/tmp/a.png' } },
    ])
    expect(s.files).toEqual(['/tmp/a.png@n1:i1'])
    expect(blocks(s.events.at(-1))).toMatchObject([{ content: 'Saved to /tmp/a.png\nok' }])
  })

  it('draws a compaction row pending on progress and settled on completion', () => {
    const s = sink()
    const sc = scope()
    itemProgress(s, { id: 'k1', type: 'contextCompaction' }, sc)
    itemCompleted(s, { id: 'k1', type: 'contextCompaction' }, sc)
    expect(s.events).toEqual([
      { type: 'context_compacted', uuid: 'n1:k1', pending: true, parentToolUseId: null },
      { type: 'context_compacted', uuid: 'n1:k1', parentToolUseId: null },
    ])
  })

  it('surfaces an unknown item as an sdk_event instead of dropping it', () => {
    const s = sink()
    itemCompleted(s, { id: 'u1', type: 'somethingNew', extra: 1 } as unknown as AppServerItem, scope())
    expect(s.events).toEqual([
      { type: 'sdk_event', payload: { type: 'codex.somethingNew', item: { id: 'u1', type: 'somethingNew', extra: 1 } } },
    ])
  })

  it('opens, relabels and settles a sub-agent from its activity items', () => {
    const s = sink()
    const sc = scope()
    itemCompleted(s, { id: 'a1', type: 'subAgentActivity', kind: 'started', agentThreadId: 't2' }, sc)
    itemCompleted(s, { id: 'a2', type: 'subAgentActivity', kind: 'message', agentThreadId: 't2', agentPath: '/root/reviewer' }, sc)
    itemCompleted(s, { id: 'a3', type: 'subAgentActivity', kind: 'completed', agentThreadId: 't2' }, sc)

    const uses = s.events.filter((e) => e.type === 'assistant_message').map((e) => blocks(e)[0])
    expect(uses).toEqual([
      { type: 'tool_use', id: 'n1:a1', name: CODEX_AGENT_TOOL, input: { agentThreadId: 't2' } },
      {
        type: 'tool_use',
        id: 'n1:a1',
        name: CODEX_AGENT_TOOL,
        input: { subagent_type: 'reviewer', agentThreadId: 't2', agentPath: '/root/reviewer' },
      },
    ])
    expect(s.agents.get('t2')).toMatchObject({ status: 'done', agentType: 'reviewer' })
  })

  it('ignores activity naming the root thread, and closes a replayed agent neutrally', () => {
    const s = sink({ replaying: true })
    itemCompleted(s, { id: 'a0', type: 'subAgentActivity', kind: 'started', agentThreadId: 'root' }, scope())
    itemCompleted(s, { id: 'a1', type: 'subAgentActivity', kind: 'started', agentThreadId: 't2' }, scope())
    expect(s.events).toHaveLength(2)
    expect(blocks(s.events[1])).toMatchObject([{ is_error: undefined }])
    expect(s.agents.get('t2')).toBeUndefined()
  })

  it('routes a child thread through its own agent scope and a root item through the live turn', () => {
    const s = sink()
    const live = scope('turn')
    const idle = scope('idle')
    const child = itemContext(
      s,
      { threadId: 't9', item: { id: 'x', type: 'agentMessage' } },
      { activeScope: live, idleScope: idle, clearedThreads: new Set() },
    )
    expect(child?.agent?.toolUseId).toBe('turn:agent:t9')
    expect(itemContext(s, { threadId: 'root' }, { activeScope: live, idleScope: idle, clearedThreads: new Set() })).toEqual({ scope: live })
    expect(
      itemContext(s, { threadId: 'gone' }, { activeScope: undefined, idleScope: idle, clearedThreads: new Set(['gone']) }),
    ).toBeUndefined()
    expect(
      itemContext(s, { item: { type: 'subAgentActivity' } }, { activeScope: undefined, idleScope: idle, clearedThreads: new Set() }),
    ).toEqual({ scope: idle })
  })

  it('settles an agent from its own turn/completed with the last agent message as the report', () => {
    const s = sink()
    s.agents.open('t2', 'n1:a1', undefined, 0)
    settleAgentTurn(s, {
      threadId: 't2',
      turn: { id: 'x', status: 'completed', items: [{ id: 'm', type: 'agentMessage', text: 'done it' }] },
    })
    expect(blocks(s.events[0])).toMatchObject([{ tool_use_id: 'n1:a1', content: 'done it' }])
    expect(s.agents.get('t2')?.status).toBe('done')
  })

  it('separates reasoning sections with a blank line and honours includePartialMessages', () => {
    const s = sink()
    const context = { scope: scope() }
    reasoningDelta(s, 'item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'one', summaryIndex: 0 }, context)
    reasoningDelta(s, 'item/reasoning/summaryTextDelta', { itemId: 'r', delta: 'two', summaryIndex: 1 }, context)
    expect(s.events.map((e) => (e as unknown as { event: { delta: { thinking: string } } }).event.delta.thinking)).toEqual([
      'one',
      '\n\ntwo',
    ])

    const quiet = sink({ partials: false })
    reasoningDelta(quiet, 'item/reasoning/textDelta', { itemId: 'r', delta: 'x' }, { scope: scope() })
    expect(quiet.events).toEqual([])
  })

  it('builds a file_produced event with a stable id and a known media type', () => {
    const a = fileProducedEvent('/tmp/out.PNG', 'tool-1', 42)
    const b = fileProducedEvent('/tmp/out.PNG', 'tool-2', undefined)
    expect(a).toMatchObject({ type: 'file_produced', path: '/tmp/out.PNG', mediaType: 'image/png', bytes: 42, toolUseId: 'tool-1' })
    expect((a as { fileId: string }).fileId).toBe((b as { fileId: string }).fileId)
    expect(b).not.toHaveProperty('bytes')
    expect(fileProducedEvent('/tmp/notes.xyz', 't', 1)).not.toHaveProperty('mediaType')
  })
})
