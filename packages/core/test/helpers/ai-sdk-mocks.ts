// Shared MockLanguageModelV3 stream builders. Every AI-SDK-engine suite needs the same
// three shapes — a text turn, a tool-call turn, a doGenerate reply — and five of them used
// to carry their own copy under five different names.
import { convertArrayToReadableStream } from 'ai/test'

// The one usage record every mocked turn reports. Assertions elsewhere depend on these numbers.
export const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}

// A finished text turn. `perChar` splits the text into one delta per character, which is
// how the streaming suites get more than one `stream_delta` to assert on; the default
// single delta keeps the other suites' event logs readable.
export function streamText(text: string, { perChar = false }: { perChar?: boolean } = {}) {
  const deltas = perChar ? [...text] : [text]
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      { type: 'text-start' as const, id: 't1' },
      ...deltas.map((delta) => ({ type: 'text-delta' as const, id: 't1', delta })),
      { type: 'text-end' as const, id: 't1' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
    ]),
  }
}

// A turn that ends in one tool call.
export function streamCall(toolCallId: string, toolName: string, input: unknown) {
  return streamCalls([{ id: toolCallId, tool: toolName, input }])
}

// A turn that ends in a batch of tool calls — the parking suites depend on multi-call turns.
export function streamCalls(calls: Array<{ id: string; tool: string; input: unknown }>) {
  return {
    stream: convertArrayToReadableStream([
      { type: 'stream-start' as const, warnings: [] },
      ...calls.map((c) => ({
        type: 'tool-call' as const,
        toolCallId: c.id,
        toolName: c.tool,
        input: JSON.stringify(c.input),
      })),
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
    ]),
  }
}

// The doGenerate form of a text reply — the web_fetch digest pass is generate, not stream.
export function generateText(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: USAGE,
    warnings: [],
  }
}
