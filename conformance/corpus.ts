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

function assistant(uuid: string, content: unknown[], parent: string | null = null): Beat {
  return beat(
    event({ type: 'assistant_message', message: { role: 'assistant', content }, parentToolUseId: parent, uuid } as SessionEventBody),
  )
}

function userText(uuid: string, content: unknown, extra: Record<string, unknown> = {}): Beat {
  return beat(
    event({ type: 'user_message', message: { role: 'user', content }, parentToolUseId: null, uuid, ...extra } as SessionEventBody),
  )
}

function toolResult(uuid: string, block: Record<string, unknown>, extra: Record<string, unknown> = {}): Beat {
  return userText(uuid, [{ type: 'tool_result', ...block }], { synthetic: true, ...extra })
}

const SHELL = {
  id: 'sh_abc',
  sessionId: 's1',
  ordinal: 3,
  command: 'npm test',
  label: 'npm test',
  cwd: '/tmp/p',
  owner: 'user',
  status: 'running',
  startedAt: 1000,
  bytes: 12,
  cols: 120,
  rows: 40,
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
  {
    name: 'thinking-streamed-then-superseded',
    tape: beat(
      init(),
      user('Think first.'),
      delta('Weighing ', null, 'thinking'),
      delta('the options.', null, 'thinking'),
      assistant('th-1', [
        { type: 'thinking', thinking: 'Weighing the options, fully.' },
        { type: 'text', text: 'Option B.' },
      ]),
      turnEnd(),
    ),
  },
  {
    name: 'thinking-signature-only-keeps-stream',
    tape: beat(init(), delta('Weighing it.', null, 'thinking'), assistant('th-2', [{ type: 'thinking', thinking: '', signature: 'Eu8E' }])),
  },
  {
    name: 'thinking-empty-dropped',
    tape: beat(
      init(),
      assistant('th-3', [{ type: 'thinking', thinking: '', signature: 'Eu8E' }]),
      delta('   ', null, 'thinking'),
      assistant('th-4', [{ type: 'text', text: 'Done.' }]),
      turnEnd(),
    ),
  },
  {
    name: 'thinking-addressed',
    tape: beat(
      init(),
      assistant('th-5', [{ type: 'thinking', thinking: 'reasoning' }]),
      assistant('th-6', [{ type: 'thinking', thinking: 'Two decisions from you.', addressed: true }]),
    ),
  },
  {
    name: 'cost-is-cumulative',
    tape: beat(
      init(),
      user('One.'),
      turnEnd({ totalCostUsd: 0.1 }),
      user('Two.'),
      event({ type: 'turn_result', subtype: 'success', isError: false, durationMs: 10, numTurns: 1, totalCostUsd: 0.25, costUsd: 0.15 }),
    ),
  },
  {
    name: 'user-uuid-dedupe',
    tape: beat(
      init(),
      userText('dup-1', 'earlier prompt'),
      assistant('dup-a', [{ type: 'text', text: 'earlier reply' }]),
      userText('dup-1', 'earlier prompt'),
    ),
  },
  {
    name: 'file-delivered',
    tape: beat(init(), event({ type: 'file_delivered', path: '/SUMMARY.md', bytes: 42, description: 'the summary' })),
  },
  {
    name: 'local-command-synthetic-and-caveat',
    tape: beat(
      init(),
      userText('lc-1', '<local-command-stdout>$ ls\nREADME.md</local-command-stdout>', { synthetic: true }),
      userText(
        'mix-1',
        [
          {
            type: 'text',
            text:
              '<local-command-caveat>Caveat: generated</local-command-caveat>\n' +
              '<local-command-stdout>$ ls\nREADME.md</local-command-stdout>\n' +
              '<local-command-stderr>$ nope\nnot found</local-command-stderr>',
          },
          { type: 'text', text: 'what did that print?' },
        ],
        { synthetic: true },
      ),
      userText('syn-1', 'a synthetic nudge the user never typed', { synthetic: true }),
    ),
  },
  {
    name: 'slash-command-text',
    tape: beat(
      init(),
      userText(
        'cmd-1',
        '<command-message>wrapup</command-message>\n<command-name>/dev:wrapup</command-name>\n<command-args>(commit only)</command-args>',
      ),
      userText('cmd-2', 'compare <a> and <b>'),
    ),
  },
  {
    name: 'attachments',
    tape: beat(
      init(),
      userText('att-1', 'what is this?', { attachments: [{ id: 'att-a', name: 'shot.png', mediaType: 'image/png', bytes: 1024 }] }),
      userText('att-2', '', { attachments: [{ id: 'att-b', name: 'notes.pdf', mediaType: 'application/pdf', bytes: 2048 }] }),
    ),
  },
  {
    name: 'catalog-and-produced-files',
    tape: beat(
      event({ type: 'capabilities', models: [], commands: [{ name: 'compact', description: 'Compact' }], defaultModel: 'claude-opus-5-5' }),
      init(),
      event({ type: 'file_produced', path: '/work/acme/out.png', fileId: 'f1', mediaType: 'image/png', bytes: 512 }),
      event({ type: 'file_produced', path: '/work/acme/out.png', fileId: 'f1', mediaType: 'image/png', bytes: 512 }),
      event({ type: 'tool_titles', titles: { mcp__acme__deploy: 'Deploy' } }),
    ),
  },
  {
    name: 'reset-stacks-and-keeps-approvals',
    tape: beat(
      init(),
      user('First.'),
      ask({ id: 'req-9', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'toolu_x' }),
      event({ type: 'conversation_reset' }),
      user('Second.'),
      event({ type: 'conversation_reset', sdkSessionId: 'sdk-third' }),
    ),
  },
  {
    name: 'execution-states',
    tape: beat(
      init(),
      assistant('ex-a1', [{ type: 'tool_use', id: 'ex-1', name: 'eval_script', input: { script: '1+1' } }]),
      event({ type: 'execution_dispatched', executionId: 'ex-1', toolName: 'eval_script', backend: 'browser' }),
      event({ type: 'execution_result', executionId: 'ex-1', output: { type: 'json', value: { n: 2 } }, logs: ['[log] hi'] }),
      assistant('ex-a2', [{ type: 'tool_use', id: 'ex-2', name: 'eval_script', input: { script: 'wait()' } }]),
      event({ type: 'execution_dispatched', executionId: 'ex-2', toolName: 'eval_script', backend: 'remote', deferred: true }),
      assistant('ex-a3', [{ type: 'tool_use', id: 'ex-3', name: 'eval_script', input: { script: 'loop()' } }]),
      event({ type: 'execution_dispatched', executionId: 'ex-3', toolName: 'eval_script', backend: 'browser' }),
      event({ type: 'execution_failed', executionId: 'ex-3', reason: 'timeout', error: 'guest exceeded its deadline' }),
      event({ type: 'execution_result', executionId: 'ex-unknown', output: { type: 'text', value: 'ignored' } }),
    ),
  },
  {
    name: 'tool-result-patch',
    tape: beat(
      init(),
      tool('toolu_edit', 'Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult(
        'r-edit',
        { tool_use_id: 'toolu_edit', content: 'updated' },
        {
          patch: {
            path: '/repo/a.ts',
            kind: 'update',
            hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ['-a', '+b'] }],
          },
        },
      ),
    ),
  },
  {
    name: 'subagents-streaming-apart',
    tape: beat(
      init(),
      user('Two agents.'),
      tool('toolu_a', 'Task', { description: 'A' }),
      tool('toolu_b', 'Task', { description: 'B' }),
      delta('parent says', null),
      delta('agent A says', 'toolu_a'),
      delta('agent B says', 'toolu_b'),
      say('A is done.', { parent: 'toolu_a' }),
      turnEnd(),
    ),
  },
  {
    name: 'tool-output-live-tail',
    tape: beat(
      init(),
      tool('toolu_bash', 'Bash', { command: 'pip install torch' }),
      event({ type: 'tool_output', toolUseId: 'toolu_bash', tail: 'Downloading torch' }),
      event({ type: 'tool_output', toolUseId: 'toolu_nobody', tail: 'ignored' }),
      tool('toolu_bash2', 'Bash', { command: 'sleep 1' }),
      event({ type: 'tool_output', toolUseId: 'toolu_bash2', tail: 'still going' }),
      toolResult('r-bash2', { tool_use_id: 'toolu_bash2', content: 'ok' }),
      event({ type: 'tool_output', toolUseId: 'toolu_bash2', tail: 'late' }),
    ),
  },
  {
    name: 'tool-result-truncated-and-images',
    tape: beat(
      init(),
      tool('toolu_big', 'Bash', { command: 'cat big.log' }),
      toolResult('r-big', { tool_use_id: 'toolu_big', content: 'first part of the log', truncated: true, total_chars: 120000 }),
      tool('toolu_shot', 'mcp__browser__screenshot', {}),
      toolResult('r-shot', {
        tool_use_id: 'toolu_shot',
        content: [
          { type: 'text', text: 'looked at the screenshot' },
          { type: 'image_ref', part_index: 1, media_type: 'image/png', bytes: 340000 },
        ],
      }),
    ),
  },
  {
    name: 'shell-row',
    tape: beat(
      init(),
      userText('sh-row', '<local-command-stdout>$ npm test\nrunning</local-command-stdout>', { synthetic: true, shell: SHELL }),
      userText('sh-row', '<local-command-stdout>$ npm test\nall good\n[exit 0]</local-command-stdout>', {
        synthetic: true,
        shell: { ...SHELL, status: 'exited', exitCode: 0, endReason: 'exit', endedAt: 2000 },
      }),
    ),
  },
  {
    name: 'ignored-events',
    tape: beat(
      init(),
      event({ type: 'sdk_event', payload: { type: 'hook_started' } }),
      event({ type: 'session_closed', reason: 'client' }),
      event({ type: 'stream_delta', event: { type: 'message_start' }, parentToolUseId: null, uuid: 'ms-1' } as SessionEventBody),
    ),
  },
  {
    name: 'markdown-blocks',
    tape: beat(
      init(),
      user('Summarise.'),
      say(
        [
          '# Summary',
          '',
          'The fix has **three** parts, see `transcript.ts` and the [docs](https://example.com/docs).',
          '',
          '## Steps',
          '',
          '1. Read the *reducer*.',
          '2. Port the ~~old~~ new planner.',
          '   - nested bullet with `code`',
          '- a plain bullet',
          '',
          '> A quoted line that is long enough to wrap across more than one terminal line at this width, surely.',
          '',
          '```ts',
          'export function plan(row: Row): Line[] {',
          '  return []',
          '}',
          '```',
          '',
          '| Area | State |',
          '| --- | --- |',
          '| VT | done |',
          '| Planner | partial |',
          '',
          '---',
          'Escaped \\*not emphasis\\* and a_snake_case_name.',
        ].join('\n'),
      ),
      turnEnd(),
    ),
  },
  {
    name: 'wrapping-wide-text',
    tape: beat(
      init(),
      user(`${'A long prompt that keeps going '.repeat(8)}end.`),
      say(`漢字かな交じり文 ${'界'.repeat(70)} then emoji 🙂👍🏽 and a URL https://example.com/${'segment/'.repeat(20)}end`),
      tool('toolu_long', 'Bash', { command: `echo ${'x'.repeat(300)}` }),
      result('toolu_long', Array.from({ length: 30 }, (_, index) => `output line ${index + 1}`).join('\n')),
      turnEnd(),
    ),
  },
  {
    name: 'peer-send',
    tape: beat(
      init(),
      user('Tell the reviewer.'),
      tool('toolu_peer1', 'mcp__workerdeck__peers_send', { to: 'WD-Review', message: 'Ready for review: **two** commits on `refactor/rust`.' }),
      result('toolu_peer1', 'Delivered to WD-Review.'),
      tool('toolu_peer2', 'peers_send', { to: 'WD-MonkeyArt', message: 'Avatars next.' }),
      result('toolu_peer2', 'Delivered.'),
      tool('toolu_after', 'Read', { file_path: `${CWD}/a.ts` }),
      result('toolu_after', 'export const a = 1'),
      say('Both told.'),
      turnEnd(),
    ),
  },
  {
    name: 'todowrite-tool',
    tape: beat(
      init(),
      user('Plan the work.'),
      tool('toolu_todo', 'TodoWrite', {
        todos: [
          { content: 'Read the reducer', status: 'completed', activeForm: 'Reading the reducer' },
          { content: 'Port the planner branches for expansion states', status: 'in_progress', activeForm: 'Porting the planner' },
          { content: 'Regenerate the goldens', status: 'pending', activeForm: 'Regenerating' },
        ],
      }),
      result('toolu_todo', 'Todos have been modified successfully.'),
      turnEnd(),
    ),
  },
  {
    name: 'tool-runs',
    tape: beat(
      init(),
      user('Look around.'),
      tool('toolu_r1', 'Read', { file_path: `${CWD}/a.ts` }),
      result('toolu_r1', Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n')),
      tool('toolu_r2', 'Grep', { pattern: 'applyEvent', path: CWD }),
      result('toolu_r2', 'packages/react/src/lib/transcript.ts'),
      tool('toolu_r3', 'Bash', { command: 'ls missing' }),
      result('toolu_r3', 'ls: missing: No such file or directory', { isError: true }),
      tool('toolu_r4', 'Glob', { pattern: '**/*.rs' }),
      say('Found it.'),
      turnEnd(),
    ),
  },
  {
    name: 'subagent-long-brief',
    tape: beat(
      init(),
      user('Delegate.'),
      tool('toolu_bg', 'Task', {
        description: 'Audit the planner',
        prompt: Array.from({ length: 9 }, (_, index) => `Step ${index + 1}: check the branch that plans case ${index + 1} and report any drift you find.`).join('\n'),
      }),
      think('Start with the run fold.', 'toolu_bg'),
      tool('toolu_bg_r1', 'Read', { file_path: `${CWD}/planner.rs` }, 'toolu_bg'),
      result('toolu_bg_r1', 'fn plan_run() {}', { parent: 'toolu_bg' }),
      tool('toolu_bg_r2', 'Grep', { pattern: 'plan_task' }, 'toolu_bg'),
      result('toolu_bg_r2', 'planner.rs:693', { parent: 'toolu_bg' }),
      say('No drift in the run fold.', { parent: 'toolu_bg' }),
      result('toolu_bg', 'No drift found.'),
      say('The audit found nothing.'),
      turnEnd(),
    ),
  },
  {
    name: 'diffs',
    tape: beat(
      init(),
      tool('toolu_multi', 'Edit', { file_path: '/repo/b.ts', old_string: 'x', new_string: 'y' }),
      toolResult(
        'r-multi',
        { tool_use_id: 'toolu_multi', content: 'updated' },
        {
          patch: {
            path: '/repo/b.ts',
            kind: 'update',
            hunks: [
              { oldStart: 2, oldLines: 3, newStart: 2, newLines: 4, lines: [' keep', '-old one', '+new one', '+added', ' tail'] },
              { oldStart: 40, oldLines: 2, newStart: 41, newLines: 1, lines: ['-gone', ' stays'] },
            ],
          },
        },
      ),
      tool('toolu_write', 'Write', { file_path: '/repo/new.ts', content: 'export {}' }),
      toolResult(
        'r-write',
        { tool_use_id: 'toolu_write', content: 'created' },
        { patch: { path: '/repo/new.ts', kind: 'add', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+export {}', '+// end'] }] } },
      ),
    ),
  },
  {
    name: 'long-thinking-and-result',
    tape: beat(
      init(),
      user('Dig in.'),
      think(`${'A thought that runs well past the width of one terminal line, '.repeat(4)}\nand a second paragraph.`),
      tool('toolu_huge', 'Bash', { command: 'cat huge.txt' }),
      result('toolu_huge', Array.from({ length: 120 }, (_, index) => `row ${index + 1} ${'data '.repeat(6)}`).join('\n')),
      turnEnd(),
    ),
  },
  {
    name: 'shell-failed-long',
    tape: beat(
      init(),
      userText(
        'sh-fail',
        `<local-command-stdout>$ make\n${Array.from({ length: 14 }, (_, index) => `step ${index + 1}`).join('\n')}\nmake: *** [all] Error 2\n[exit 2]</local-command-stdout>`,
        { synthetic: true, shell: { ...SHELL, id: 'sh_fail', command: 'make', label: 'make', status: 'exited', exitCode: 2, endReason: 'exit', endedAt: 3000 } },
      ),
    ),
  },
  {
    name: 'shell-running',
    tape: beat(
      init(),
      userText('sh-live', '<local-command-stdout>$ npm run dev\nlistening on :5173</local-command-stdout>', { synthetic: true, shell: SHELL }),
    ),
  },
]

export const DUPLICATES = new Set(['duplicate-seq-replay'])
