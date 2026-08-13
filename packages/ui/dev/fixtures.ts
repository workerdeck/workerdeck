import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'

/**
 * Canned transcripts for the playground.
 *
 * Hand-written rather than captured, and chosen for the cases that break a
 * renderer: prose that wraps, a message that is mostly markdown, output that is
 * far longer than its row, a call still in flight, a failure, and a turn that
 * ended. If a fixture looks right at three widths, the theme is right.
 */

let seq = 0

/** Stamps the id, so a fixture says what it is about and nothing else.
 * `Omit` has to distribute over the union by hand — applied to the union
 * directly it collapses to the members' common keys, and every fixture's own
 * fields would then be rejected. */
type ItemDraft = TranscriptItem extends infer T ? (T extends object ? Omit<T, 'id'> : never) : never

const item = (draft: ItemDraft): TranscriptItem => ({ ...draft, id: `f${++seq}` }) as TranscriptItem

const base = (items: TranscriptItem[], status: TranscriptState['status']): TranscriptState => ({
  status,
  items,
  cwd: '/Users/atomic/projects/silkweave',
  model: 'claude-opus-5',
  engine: 'claude',
  capabilities: ENGINE_CAPABILITIES.claude,
  contextUsage: { categories: [], totalTokens: 49_000, maxTokens: 200_000, percentage: 24.5 },
  pendingApprovals: [],
  totalCostUsd: 0.42,
  lastSeq: items.length,
})

/** A run in progress: prose, a tool call, its output, and the working line. */
const run: TranscriptItem[] = [
  item({ kind: 'user',
    text: 'Set up prettier for the repo, but only for code — markdown and JSON churn buys nothing.',
  }),
  item({ kind: 'assistant_text',
    text: 'Now applying the format and immediately verifying nothing broke:',
    streaming: false,
    parentToolUseId: null,
  }),
  item({ kind: 'thinking',
    text: 'Thought for 9s, ran 1 shell command',
    parentToolUseId: null,
  }),
  item({ kind: 'assistant_text',
    text: 'Format applied. Now checking whether oxlint discovers the root config from a package subdirectory — that determines whether the per-package `lint` scripts can stay as-is:',
    streaming: false,
    parentToolUseId: null,
  }),
  item({ kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm exec prettier --write .', description: 'Format the repo' },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: 'packages/protocol/src/index.ts 41ms\npackages/core/src/runner.ts 88ms\npackages/server/src/http.ts 120ms\npackages/ui/src/theme.css 12ms\npackages/web/src/main.tsx 9ms\n\n312 files changed',
      isError: false,
    },
  }),
  item({ kind: 'assistant_text',
    text: "Exit 0 doesn't prove it found the config (defaults would also pass). Testing decisively:",
    streaming: false,
    parentToolUseId: null,
  }),
  item({ kind: 'tool_call',
    name: 'Bash',
    input: {
      command:
        'pwd && /Users/atomic/projects/silkweave/node_modules/.bin/oxlint --print-config 2>&1 | node -e "let s=\'\';process.stdin.on(\'data\',d=>s+=d).on(\'end\',()=>{try{const j=JSON.parse(s);console.log(\'categories:\',JSON.stringify(j.categories))}catch(e){console.log(\'parse failed\')}})"',
    },
    parentToolUseId: null,
    status: 'running',
  }),
]

/** A file edit, with the engine's own hunks — the CLI's most distinctive row.
 * Modelled on the reference screenshot: a `.prettierrc` gaining ignore patterns,
 * plus a second, far-off hunk so the separator and the number jump are visible. */
const diff: TranscriptItem[] = [
  item({ kind: 'user', text: 'Add the ignore patterns we agreed on.' }),
  item({ kind: 'assistant_text', streaming: false, parentToolUseId: null, text: 'Adding them:' }),
  item({
    kind: 'tool_call',
    name: 'Edit',
    input: { file_path: '/Users/atomic/projects/silkweave/.prettierrc' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'The file /Users/atomic/projects/silkweave/.prettierrc has been updated.', isError: false },
    patch: {
      path: '/Users/atomic/projects/silkweave/.prettierrc',
      kind: 'update',
      hunks: [
        {
          oldStart: 6,
          oldLines: 5,
          newStart: 6,
          newLines: 11,
          lines: [
            '   "printWidth": 120,',
            '   "ignorePatterns": [',
            '+    // Code only. Markdown is published content (blog posts, READMEs) where reflowing',
            '+    // can change rendered output, and JSON/CSS churn buys nothing.',
            '+    "**/*.md",',
            '+    "**/*.json",',
            '+    "**/*.jsonc",',
            '+    "**/*.css",',
            '     "**/build/**",',
            '     "**/dist/**",',
            '     "**/.next/**",',
          ],
        },
        {
          oldStart: 98,
          oldLines: 3,
          newStart: 104,
          newLines: 3,
          lines: ['   "semi": false,', '-  "singleQuote": false,', '+  "singleQuote": true,', '   "trailingComma": "all"'],
        },
      ],
    },
  }),
]

/** Everything a message can contain: the markdown map's whole surface. */
const markdown: TranscriptItem[] = [
  item({ kind: 'user', text: 'Summarise the packaging rules.' }),
  item({ kind: 'assistant_text',
    streaming: false,
    parentToolUseId: null,
    text: `## Packaging

Releases go through **pnpm only** — \`npm publish\` would ship \`workspace:*\` verbatim.

The rules, in order:

1. Bump every package with \`version:set\`
2. Run \`pnpm install --lockfile-only\`
3. Push a \`v<x.y.z>\` tag

Things that are *not* the release record:

- \`package.json\` — it is the intent, not the outcome
- a local tag nobody pushed
- this file

> Check npm and the pushed tags. Both, every time.

\`\`\`bash
pnpm version:set 0.16.0
pnpm install --lockfile-only
git tag v0.16.0 && git push --tags
\`\`\`

| package | published | notes |
| --- | --- | --- |
| protocol | yes | bump on breaking |
| ui | yes | ships src |

---

See [the workflow](https://github.com/workerdeck/workerdeck) for the gate it re-runs.`,
  }),
]

/** The unhappy paths — a failure, a notice, and a turn that ended badly. */
const failure: TranscriptItem[] = [
  item({ kind: 'user', text: 'Run the tests.' }),
  item({ kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm test' },
    parentToolUseId: null,
    status: 'failed',
    result: {
      text: "FAIL packages/server/test/scope.test.ts\n  ● scope › a scoped principal cannot list another's sessions\n    expected 404, received 200\n      at Object.<anonymous> (test/scope.test.ts:88:14)\n\nTests: 1 failed, 214 passed",
      isError: true,
    },
  }),
  item({ kind: 'notice', level: 'error', text: 'Session ended: the runner exited with code 1' }),
  item({ kind: 'turn_result',
    subtype: 'error_during_execution',
    isError: true,
    durationMs: 42_000,
    totalCostUsd: 0.184,
    errors: ['Test suite failed', 'No files were changed'],
  }),
]

/** A long, quiet run: enough rows to scroll, and the shape you skim. */
const long: TranscriptItem[] = Array.from({ length: 40 }, (_, index) =>
  index % 3 === 0
    ? item({ kind: 'assistant_text',
        text: `Step ${index / 3 + 1}: checking the next package for the same pattern, then moving on if it is clean.`,
        streaming: false,
        parentToolUseId: null,
      })
    : item({ kind: 'tool_call',
        name: index % 3 === 1 ? 'Read' : 'Edit',
        input:
          index % 3 === 1
            ? { file_path: `/Users/atomic/projects/silkweave/packages/pkg-${index}/src/index.ts` }
            : {
                file_path: `/Users/atomic/projects/silkweave/packages/pkg-${index}/src/index.ts`,
                old_string: 'const x = 1',
                new_string: 'const x = 2',
              },
        parentToolUseId: null,
        status: 'settled',
        result: { text: `pkg-${index}: 1 change`, isError: false },
      }),
)

/** An approval for a file edit — the change shown as a diff, without line
 * numbers, because the edit has not happened yet. */
export const EDIT_APPROVAL: PermissionRequest = {
  id: 'req-1',
  toolUseId: 'tool-9',
  toolName: 'Edit',
  displayName: 'Edit file',
  title: 'Do you want to make this edit to settings.json?',
  input: {
    file_path: '~/.claude/settings.json',
    old_string: '    "Read(//Users/atomic/.claude/**)",\n    "Read(//Users/atomic/**)",',
    new_string: '    "Read(//Users/atomic/.claude/**)",',
  },
}

/** A Bash approval — nothing to diff, so the command is the subject. */
export const BASH_APPROVAL: PermissionRequest = {
  id: 'req-2',
  toolUseId: 'tool-10',
  toolName: 'Bash',
  displayName: 'Run shell command',
  title: 'Do you want to run this command?',
  description: 'The agent will run this in /Users/atomic/projects/silkweave.',
  decisionReason: 'No matching allow rule in settings.json',
  input: { command: 'rm -rf node_modules && pnpm install' },
}

/** The question tool exercising everything: a one-of with a preview, a
 * multi-select with descriptions, and the review step behind them. */
export const QUESTIONS: PermissionRequest = {
  id: 'req-3',
  toolUseId: 'tool-11',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which frontend framework should we use for the new dashboard?',
        header: 'Framework',
        options: [
          {
            label: 'React (Recommended)',
            preview:
              'function Dashboard() {\n  return (\n    <div className="grid">\n      <Widget title="Sales" />\n      <Widget title="Users" />\n    </div>\n  );\n}',
          },
          { label: 'Svelte' },
          { label: 'Vue' },
        ],
      },
      {
        question: 'Which optional integrations should be enabled?',
        header: 'Integrations',
        multiSelect: true,
        options: [
          { label: 'Slack notifications', description: 'Post build/deploy events to a Slack channel.' },
          { label: 'Sentry', description: 'Capture and report runtime errors.' },
          { label: 'Analytics', description: 'Track anonymous usage metrics.' },
          { label: 'Feature flags', description: 'Enable gradual rollout via a flag service.' },
        ],
      },
    ],
  },
}

export const FIXTURES: { key: string; label: string; state: TranscriptState }[] = [
  { key: 'run', label: 'live run', state: base(run, 'running') },
  { key: 'diff', label: 'file edit', state: base(diff, 'idle') },
  { key: 'markdown', label: 'markdown', state: base(markdown, 'idle') },
  { key: 'failure', label: 'failure', state: base(failure, 'idle') },
  { key: 'long', label: 'long run', state: base(long, 'idle') },
  { key: 'empty', label: 'empty', state: base([], 'idle') },
]
