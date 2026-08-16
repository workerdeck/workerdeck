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
  // The break rule's guard, one poem per half. CommonMark: a line ending in
  // two spaces is a **hard** break and renders as <br>; a bare newline is
  // **soft** and collapses to a space under `white-space: normal`. Models
  // really do write poems both ways (GPT-5.6 Luna emits the double-space
  // form), and the calculator has been wrong in each direction once —
  // join-always undershot the hard form by ~115 lines on a long poem,
  // break-always overshot the soft form by four here.
  item({ kind: 'user', text: 'now a short poem about releases' }),
  item({ kind: 'assistant_text',
    streaming: false,
    parentToolUseId: null,
    // Hard breaks: trailing double spaces, every line renders. Appended
    // programmatically — a literal trailing space in source is one
    // format-on-save away from silently deleting the case this guards.
    text: [
      '**The Tag That Was Never Pushed**',
      '',
      ...['It sat in the local dark,', 'a name without a wire,', 'while npm told the world'].map(
        (l) => `${l}  `,
      ),
      'the old truth, entire.',
      '',
      ...['Check the registry,', 'check the remote refs too —', 'a release is what shipped,'].map(
        (l) => `${l}  `,
      ),
      'not what version:set knew.',
    ].join('\n'),
  }),
  item({ kind: 'user', text: 'again, without the trailing spaces' }),
  item({ kind: 'assistant_text',
    streaming: false,
    parentToolUseId: null,
    // Soft breaks: bare newlines, the stanza joins and wraps as prose.
    text: `**The Tag, Rejoined**

It sat in the local dark,
a name without a wire,
while npm told the world
the old truth, entire.`,
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

/** 600 rows of varied height — the scale where estimate error becomes
 * visible scrollbar drift and short-landing jumps. Rendered with a catch-up
 * splice at item 300 (see App.tsx), so the recap jump exercises the re-aim
 * loop across ~300 unmeasured rows. */
const huge: TranscriptItem[] = Array.from({ length: 600 }, (_, index) => {
  const step = index % 6
  if (step === 0)
    return item({ kind: 'user',
      text: `Task ${index / 6 + 1}: tighten the next module, keep the diff small, and stop if anything looks structural rather than local.`,
    })
  if (step === 1)
    return item({ kind: 'assistant_text',
      streaming: false,
      parentToolUseId: null,
      text:
        `Looking at module ${index}. ` +
        'The pattern from the previous pass applies here too. '.repeat(1 + (index % 4)),
    })
  if (step === 2 || step === 3)
    return item({ kind: 'tool_call',
      name: 'Read',
      input: { file_path: `/repo/src/module-${index}/index.ts` },
      parentToolUseId: null,
      status: 'settled',
      result: {
        text: Array.from({ length: 1 + (index % 5) }, (_, l) => `line ${l + 1} of the output`).join('\n'),
        isError: false,
      },
    })
  if (step === 4)
    return item({ kind: 'tool_call',
      name: 'Edit',
      input: { file_path: `/repo/src/module-${index}/index.ts`, old_string: 'a', new_string: 'b' },
      parentToolUseId: null,
      status: 'settled',
      result: { text: `module-${index}: updated`, isError: false },
    })
  return item({ kind: 'turn_result',
    subtype: 'success',
    isError: false,
    durationMs: 30_000 + index * 10,
    totalCostUsd: 0.05,
  })
})

/**
 * A massive, varied session for performance work — every content shape the
 * renderer knows, cycled deterministically over thousands of items (~10× the
 * `huge` fixture, with far heavier rows). This is what `__wdPerf()` sweeps;
 * it is deliberately bigger than any session ought to get, so a cost that
 * grows with session size is visible here first.
 */
const perf: TranscriptItem[] = Array.from({ length: 4000 }, (_, index) => {
  const turn = Math.floor(index / 10)
  switch (index % 10) {
    case 0:
      return item({ kind: 'user',
        text: `Task ${turn}: review the module, refactor what you find, and summarise. ${'Keep the diff reviewable. '.repeat(1 + (turn % 3))}`,
      })
    case 1:
      return item({ kind: 'thinking',
        text: `Thought for ${3 + (turn % 20)}s about module ${turn} and its ${1 + (turn % 7)} call sites`,
        parentToolUseId: null,
      })
    case 2:
      // Stanza text: hard line breaks, the calculator's hardest common case.
      return item({ kind: 'assistant_text',
        streaming: false,
        parentToolUseId: null,
        text: Array.from({ length: 3 + (turn % 4) }, (_, s) =>
          Array.from({ length: 4 }, (_, l) =>
            `stanza ${s + 1} line ${l + 1} of note ${turn}, ${'holding steady '.repeat(1 + ((s + l) % 3))}`.trim(),
          ).join('\n'),
        ).join('\n\n'),
      })
    case 3:
    case 4:
      // Consecutive shell calls — folds into a ToolRunRow.
      return item({ kind: 'tool_call',
        name: 'Bash',
        input: { command: `pnpm --filter @workerdeck/mod-${index} test`, description: `Test module ${index}` },
        parentToolUseId: null,
        status: 'settled',
        result: {
          text: Array.from({ length: 2 + (index % 6) }, (_, l) => `✓ case ${l + 1} passed (${l * 7}ms)`).join('\n'),
          isError: false,
        },
      })
    case 5:
      return item({ kind: 'tool_call',
        name: 'Read',
        input: { file_path: `/repo/src/module-${turn}/index.ts` },
        parentToolUseId: null,
        status: 'settled',
        result: {
          text: Array.from({ length: 20 + (turn % 30) }, (_, l) => `${l + 1}  export const symbol${l} = build(${l})`).join('\n'),
          isError: false,
        },
      })
    case 6:
      return item({ kind: 'tool_call',
        name: 'Edit',
        input: { file_path: `/repo/src/module-${turn}/index.ts` },
        parentToolUseId: null,
        status: 'settled',
        result: { text: `module-${turn}: updated`, isError: false },
        patch: {
          path: `/repo/src/module-${turn}/index.ts`,
          kind: 'update',
          hunks: [
            {
              oldStart: 10 + turn,
              oldLines: 4,
              newStart: 10 + turn,
              newLines: 5,
              lines: [
                '   const before = context(1)',
                `-  const value = legacy(${turn})`,
                `+  // module ${turn}: computed at build time`,
                `+  const value = modern(${turn})`,
                '   return value',
              ],
            },
          ],
        },
      })
    case 7:
      return item({ kind: 'assistant_text',
        streaming: false,
        parentToolUseId: null,
        text: `## Module ${turn}

The refactor holds. ${'The call sites stay compatible and the tests agree. '.repeat(1 + (turn % 4))}

- kept the public surface
- \`legacy(${turn})\` → \`modern(${turn})\`
- ${1 + (turn % 5)} call sites updated

| check | result |
| --- | --- |
| tests | pass |
| types | clean |`,
      })
    case 8:
      return turn % 7 === 3
        ? item({ kind: 'notice', level: 'error', text: `module ${turn}: transient watcher error, retried once` })
        : item({ kind: 'assistant_text',
            streaming: false,
            parentToolUseId: null,
            text: `Module ${turn} done; moving on.`,
          })
    default:
      return item({ kind: 'turn_result',
        subtype: turn % 11 === 5 ? 'error_during_execution' : 'success',
        isError: turn % 11 === 5,
        durationMs: 20_000 + turn * 17,
        totalCostUsd: 0.03,
        ...(turn % 11 === 5 ? { errors: ['interrupted'] } : {}),
      })
  }
})

/** Content chosen to break a row-height calculator — long unbroken
 * tokens, CJK, emoji, combining marks, tabs, a wide table, a deep diff. Used by
 * the height audit (`height-audit.ts`); adversarial on purpose. */
const adversarial: TranscriptItem[] = [
  // A tool result far bigger than the expanded row's character budget — the case
  // the fixtures file claimed to cover and did not: nothing here reached 2000
  // characters, which is how the "show all N chars" button stayed a no-op
  // without anyone noticing. Expanded, this must clip and offer the rest.
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm -w test --reporter verbose' },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: Array.from(
        { length: 400 },
        (_, index) => ` ✓ packages/core/test/runner.test.ts > case ${index + 1} of 400 (${index * 3}ms)`,
      ).join('\n'),
      isError: false,
    },
  }),
  item({ kind: 'user',
    text: 'Wrap model against the wall: a token that cannot break anywhere, wide glyphs, tables.\n\n第二段是中文的，全部都是宽字符，还混了一个 emoji 🎉 以及组合字符 é（e + U+0301）。',
  }),
  item({ kind: 'assistant_text',
    streaming: false,
    parentToolUseId: null,
    text: `## What breaks a character-cell calculator

The URL https://registry.npmjs.org/@workerdeck/protocol/-/protocol-0.16.0.tgz?integrity=sha512-abcdef0123456789 is one unbreakable token, while \`session-list.ts\` and **bold text** and [a link](https://example.com) all change width between source and render.

1. An ordered item whose text is long enough to wrap onto a second visual line at any dock width worth testing
2. Short one
3. Third with \`inline code\`

- An unordered list item
- Nested below:
  - a second-level item that also wraps when the panel is narrow enough to squeeze it

> A quote paragraph that should wrap inside its two-cell rule indent.
>
> And a second paragraph inside the same quote.

\`\`\`ts
const veryLongLine = buildSomething(withArguments, thatMakeThisLine, muchLongerThan, eightyColumns, soItWraps)
\tindented with a tab
short
\`\`\`

| package | published | notes | a fourth column to make it wide |
| --- | --- | --- | --- |
| protocol | yes | bump on breaking | wire types, browser safe, no deps |
| ui | yes | ships src | tailwind v4, base-ui, cva |

---

漢字テキストの段落。カタカナとひらがなが混ざっていて、折り返し位置は全角文字の幅に依存する。`,
  }),
  item({ kind: 'thinking',
    text: 'Considering 👩‍💻 a ZWJ sequence and a naïve café — combining marks résumé…',
    parentToolUseId: null,
  }),
  item({ kind: 'tool_call',
    name: 'Read',
    input: { file_path: '/Users/atomic/projects/silkweave/packages/deeply/nested/with-a-very-long-single-component-file-name-that-cannot-break-anywhere-at-all.generated.ts' },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: 'line one\tafter a tab\naverylongunbrokenidentifierthatkeepsgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoing = 1\n中文输出行，包含宽字符\n\nlast line after an empty one',
      isError: false,
    },
  }),
  item({ kind: 'tool_call',
    name: 'Edit',
    input: { file_path: '/Users/atomic/projects/silkweave/packages/server/src/http.ts' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'The file has been updated.', isError: false },
    patch: {
      path: '/Users/atomic/projects/silkweave/packages/server/src/http.ts',
      kind: 'update',
      hunks: [
        {
          oldStart: 1042,
          oldLines: 4,
          newStart: 1042,
          newLines: 5,
          lines: [
            '           if (session) {',
            '             const principal = await authenticate(request)',
            '-            if (!principal) return refuse(response, 401)',
            '+            if (!principal) return refuse(response, 401, "authentication required for every scoped route")',
            '+            if (!authorizeSession(principal, session.info())) return refuse(response, 404)',
            '             return handler(request, response, session, principal)',
          ],
        },
      ],
    },
  }),
  item({ kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm typecheck' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'done in 4.2s', isError: false },
  }),
  item({ kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm lint' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'ok', isError: false },
  }),
  item({ kind: 'notice',
    level: 'info',
    text: 'Long notice with an unbreakable middle: /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/workerdeck-attachments-4f6a2c1e9b7d filled the line.',
  }),
  item({ kind: 'file_delivered',
    path: 'reports/quarterly-summary-with-a-longer-than-usual-name.pdf',
    bytes: 2_400_000,
    description: 'Generated from the fixture data',
  }),
  item({ kind: 'turn_result',
    subtype: 'error_during_execution',
    isError: true,
    durationMs: 63_000,
    totalCostUsd: 0.92,
    errors: [
      'A very long error message that will certainly wrap at every width under test because it keeps enumerating the things that went wrong, one after another, without a single break-friendly token boundary of unusual kind',
    ],
  }),
]

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
  { key: 'huge', label: 'huge (600 rows)', state: base(huge, 'idle') },
  { key: 'perf', label: 'perf (4k items)', state: base(perf, 'idle') },
  { key: 'adversarial', label: 'adversarial (spike)', state: base(adversarial, 'idle') },
  // A run with the approval standing — the scrubber pins its mark at the foot.
  {
    key: 'approval',
    label: 'pending approval',
    state: { ...base(run, 'running'), pendingApprovals: [BASH_APPROVAL] },
  },
  { key: 'empty', label: 'empty', state: base([], 'idle') },
]
