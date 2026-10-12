import type { SessionEventBody } from '@workerdeck/protocol'

import {
  ask,
  beat,
  context,
  event,
  peerMessage,
  rateLimit,
  resolved,
  result,
  say,
  status,
  think,
  todos,
  tool,
  turnEnd,
  user,
  type Beat,
} from '../apps/demo/src/stage/tape.ts'

export type Case = { name: string; tape: Beat }

const CWD = '/work/acme'

function init(model = 'claude-opus-5-5'): Beat {
  return beat(
    event({
      type: 'system_init',
      sdkSessionId: 'sdk-conformance',
      model,
      cwd: CWD,
      apiKeySource: 'ANTHROPIC_API_KEY',
      tools: ['Task', 'Bash', 'Read', 'Edit'],
      skills: [],
      slashCommands: ['compact', 'clear'],
      permissionMode: 'default',
      claudeCodeVersion: '2.1.60',
      mcpServers: [],
    }),
    status('running'),
  )
}

function delta(text: string, parent: string | null = null, kind: 'text' | 'thinking' = 'text'): Beat {
  const inner = kind === 'text' ? { type: 'text_delta', text } : { type: 'thinking_delta', thinking: text }
  return beat(
    event({
      type: 'stream_delta',
      event: { type: 'content_block_delta', index: 0, delta: inner },
      parentToolUseId: parent,
      uuid: `delta-${text.length}-${kind}`,
    } as SessionEventBody),
  )
}

export const CORPUS: Case[] = [
  {
    name: 'basic-turn',
    tape: beat(
      init(),
      user('Read the config and tell me the port.'),
      think('The port lives in the config file.'),
      tool('toolu_read', 'Read', { file_path: `${CWD}/config.json` }),
      result('toolu_read', '{\n  "port": 8080\n}'),
      say('The server listens on **8080**.', { stream: true }),
      context(12),
      turnEnd({ durationMs: 4200, totalCostUsd: 0.03 }),
    ),
  },
  {
    name: 'streaming-midway',
    tape: beat(
      init(),
      user('Count to three.'),
      delta('One, '),
      delta('two, '),
      delta('three'),
      delta('Counting carefully.', null, 'thinking'),
    ),
  },
  {
    name: 'streaming-finalized-by-turn-result',
    tape: beat(init(), user('Say hi.'), delta('Hi'), delta(' there'), turnEnd({ durationMs: 900, totalCostUsd: 0.001 })),
  },
  {
    name: 'subagent',
    tape: beat(
      init(),
      user('Survey the tests.'),
      tool('toolu_task', 'Task', { description: 'Survey tests', prompt: 'List the test files.' }),
      say('Looking at the tree.', { parent: 'toolu_task' }),
      tool('toolu_ls', 'Bash', { command: 'ls test' }, 'toolu_task'),
      result('toolu_ls', 'a.test.ts\nb.test.ts', { parent: 'toolu_task' }),
      delta('Two files', 'toolu_task'),
      say('Two files.', { parent: 'toolu_task' }),
      result('toolu_task', 'There are two test files.'),
      say('There are two test files.'),
      turnEnd(),
    ),
  },
  {
    name: 'tool-error',
    tape: beat(
      init(),
      user('Run the build.'),
      tool('toolu_build', 'Bash', { command: 'pnpm build' }),
      result('toolu_build', 'error TS2322: Type string is not assignable to number.', { isError: true }),
      say('The build fails on a type error.'),
      turnEnd(),
    ),
  },
  {
    name: 'turn-error',
    tape: beat(
      init(),
      user('Go.'),
      event({
        type: 'turn_result',
        subtype: 'error_during_execution',
        isError: true,
        durationMs: 300,
        numTurns: 1,
        totalCostUsd: 0.002,
        costUsd: 0.002,
        errors: ['overloaded'],
      }),
      event({ type: 'session_error', message: 'The engine stopped.' }),
      status('idle'),
    ),
  },
  {
    name: 'local-command-output',
    tape: beat(
      init(),
      event({
        type: 'user_message',
        message: { role: 'user', content: '<local-command-stdout>Compacted.</local-command-stdout>' },
        parentToolUseId: null,
        uuid: 'local-1',
      }),
      event({
        type: 'user_message',
        message: { role: 'user', content: '<local-command-stderr>No such command</local-command-stderr>' },
        parentToolUseId: null,
        uuid: 'local-2',
      }),
    ),
  },
  {
    name: 'duplicate-seq-replay',
    tape: beat(init(), user('Once.'), say('Only once.'), turnEnd()),
  },
  {
    name: 'permission-round-trip',
    tape: beat(
      init(),
      user('Delete the build folder.'),
      tool('toolu_rm', 'Bash', { command: 'rm -rf build' }),
      ask({ id: 'req-1', toolName: 'Bash', input: { command: 'rm -rf build' }, toolUseId: 'toolu_rm', title: 'Run rm -rf build?' }),
      ask({ id: 'req-2', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_ls2' }),
      resolved('req-1'),
    ),
  },
  {
    name: 'checklist',
    tape: beat(
      init(),
      user('Plan it.'),
      todos(['completed', 'Read the code'], ['in_progress', 'Write the fix'], ['pending', 'Run the tests']),
    ),
  },
  {
    name: 'peer-message',
    tape: beat(
      init(),
      peerMessage({ sessionId: 'sess-peer', name: 'WD-Review', engine: 'codex' }, 'Review done, two findings.'),
      say('Thanks, looking.'),
      turnEnd(),
    ),
  },
  {
    name: 'compaction',
    tape: beat(
      init(),
      user('Keep going.'),
      event({ type: 'context_compacted', uuid: 'cmp-1', pending: true, trigger: 'auto' }),
      event({ type: 'context_compacted', uuid: 'cmp-1', trigger: 'auto', preTokens: 180000, postTokens: 24000 }),
      say('Continuing after the summary.'),
    ),
  },
  {
    name: 'conversation-reset',
    tape: beat(
      init(),
      user('First conversation.'),
      say('Answer.'),
      turnEnd(),
      todos(['pending', 'Something']),
      event({ type: 'conversation_reset', sdkSessionId: 'sdk-fresh', agentReason: 'Starting the next phase.' }),
      user('Second conversation.'),
    ),
  },
  {
    name: 'session-state',
    tape: beat(
      init(),
      event({ type: 'model_changed', model: 'claude-sonnet-5-5' }),
      event({ type: 'effort_changed', effort: 'high' }),
      event({ type: 'permission_mode_changed', mode: 'acceptEdits' }),
      event({ type: 'plan_info', subscriptionType: 'max' }),
      rateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1_760_010_000, utilization: 0.4 }),
      event({ type: 'engine_sleep', asleep: true }),
      status('idle'),
    ),
  },
]

export const DUPLICATES = new Set(['duplicate-seq-replay'])
