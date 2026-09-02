import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'

let seq = 0

// `Omit` must distribute over the union by hand: applied to the union directly it collapses to the members' common keys.
type ItemDraft = TranscriptItem extends infer T ? (T extends object ? Omit<T, 'id'> : never) : never

function item(draft: ItemDraft): TranscriptItem {
  return { ...draft, id: `f${++seq}` } as TranscriptItem
}

function base(items: TranscriptItem[], status: TranscriptState['status']): TranscriptState {
  return {
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
  }
}

const run: TranscriptItem[] = [
  item({ kind: 'user', text: 'Set up prettier for the repo, but only for code — markdown and JSON churn buys nothing.' }),
  item({
    kind: 'assistant_text',
    text: 'Now applying the format and immediately verifying nothing broke:',
    streaming: false,
    parentToolUseId: null,
  }),
  item({ kind: 'thinking', text: 'Thought for 9s, ran 1 shell command', parentToolUseId: null }),
  item({
    kind: 'assistant_text',
    text: 'Format applied. Now checking whether oxlint discovers the root config from a package subdirectory — that determines whether the per-package `lint` scripts can stay as-is:',
    streaming: false,
    parentToolUseId: null,
  }),
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm exec prettier --write .', description: 'Format the repo' },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: 'packages/protocol/src/index.ts 41ms\npackages/core/src/runner.ts 88ms\npackages/server/src/http.ts 120ms\npackages/ui/src/theme.css 12ms\npackages/web/src/main.tsx 9ms\n\n312 files changed',
      isError: false,
    },
  }),
  item({
    kind: 'assistant_text',
    text: "Exit 0 doesn't prove it found the config (defaults would also pass). Testing decisively:",
    streaming: false,
    parentToolUseId: null,
  }),
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: {
      command:
        "pwd && /Users/atomic/projects/silkweave/node_modules/.bin/oxlint --print-config 2>&1 | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('categories:',JSON.stringify(j.categories))}catch(e){console.log('parse failed')}})\"",
    },
    parentToolUseId: null,
    status: 'running',
  }),
  item({
    kind: 'assistant_text',
    text: 'Tracking the rollout as a checklist while the probe runs:',
    streaming: false,
    parentToolUseId: null,
  }),
  item({
    kind: 'tool_call',
    name: 'TodoWrite',
    input: {
      todos: [
        { content: 'Audit the current prettier config', status: 'completed', activeForm: 'Auditing the current prettier config' },
        { content: 'Add the ignore patterns for markdown and JSON', status: 'completed', activeForm: 'Adding the ignore patterns' },
        {
          content:
            'Verify oxlint discovers the root config from a package subdirectory, because that decides whether the per-package lint scripts can stay as they are today',
          status: 'in_progress',
          activeForm: 'Verifying oxlint config discovery from a package subdirectory',
        },
        { content: 'Wire format-on-save into the workspace settings', status: 'pending', activeForm: 'Wiring format-on-save' },
        { content: 'Run the formatter across the repo', status: 'pending', activeForm: 'Running the formatter' },
        { content: 'Re-run the lints', status: 'pending', activeForm: 'Re-running the lints' },
        { content: 'Spot-check the largest diffs', status: 'pending', activeForm: 'Spot-checking the largest diffs' },
        { content: 'Update the contributing doc', status: 'pending', activeForm: 'Updating the contributing doc' },
        { content: 'Announce the switch in the team channel', status: 'pending', activeForm: 'Announcing the switch' },
        { content: 'Delete the old editorconfig shims', status: 'pending', activeForm: 'Deleting the old editorconfig shims' },
      ],
    },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'Todos have been modified successfully.', isError: false },
  }),
]

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

const markdown: TranscriptItem[] = [
  item({ kind: 'user', text: 'Summarise the packaging rules.' }),
  item({
    kind: 'assistant_text',
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
  // The break rule's guard, one poem per half — the height calculator has been wrong in each direction once.
  item({ kind: 'user', text: 'now a short poem about releases' }),
  item({
    kind: 'assistant_text',
    streaming: false,
    parentToolUseId: null,
    // Appended programmatically: a literal trailing space here is one format-on-save from deleting the case this guards.
    text: [
      '**The Tag That Was Never Pushed**',
      '',
      ...['It sat in the local dark,', 'a name without a wire,', 'while npm told the world'].map((l) => `${l}  `),
      'the old truth, entire.',
      '',
      ...['Check the registry,', 'check the remote refs too —', 'a release is what shipped,'].map((l) => `${l}  `),
      'not what version:set knew.',
    ].join('\n'),
  }),
  item({ kind: 'user', text: 'again, without the trailing spaces' }),
  item({
    kind: 'assistant_text',
    streaming: false,
    parentToolUseId: null,
    text: `**The Tag, Rejoined**

It sat in the local dark,
a name without a wire,
while npm told the world
the old truth, entire.`,
  }),
]

const failure: TranscriptItem[] = [
  item({ kind: 'user', text: 'Run the tests.' }),
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm test' },
    parentToolUseId: null,
    status: 'failed',
    result: {
      text: "FAIL packages/server/test/scope.test.ts\n  ● scope › a scoped principal cannot list another's sessions\n    expected 404, received 200\n      at Object.<anonymous> (test/scope.test.ts:88:14)\n\nTests: 1 failed, 214 passed",
      isError: true,
    },
  }),
  // The boundary drawn when an engine summarises its history in place. It has no text of its own —
  // the row's whole content is `COMPACTION_TEXT` — so the fixture is just the item.
  item({ kind: 'compaction', parentToolUseId: null }),
  item({ kind: 'notice', level: 'error', text: 'Session ended: the runner exited with code 1' }),
  item({
    kind: 'turn_result',
    subtype: 'error_during_execution',
    isError: true,
    durationMs: 42_000,
    totalCostUsd: 0.184,
    errors: ['Test suite failed', 'No files were changed'],
  }),
]

const long: TranscriptItem[] = Array.from({ length: 40 }, (_, index) =>
  index % 3 === 0
    ? item({
        kind: 'assistant_text',
        text: `Step ${index / 3 + 1}: checking the next package for the same pattern, then moving on if it is clean.`,
        streaming: false,
        parentToolUseId: null,
      })
    : item({
        kind: 'tool_call',
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

// 600 rows of varied height, with a catch-up splice at item 300 (see App.tsx) — the scale where estimate error becomes visible scrollbar drift.
const huge: TranscriptItem[] = Array.from({ length: 600 }, (_, index) => {
  const step = index % 6
  if (step === 0) {
    return item({
      kind: 'user',
      text: `Task ${index / 6 + 1}: tighten the next module, keep the diff small, and stop if anything looks structural rather than local.`,
    })
  }
  if (step === 1) {
    return item({
      kind: 'assistant_text',
      streaming: false,
      parentToolUseId: null,
      text: `Looking at module ${index}. ` + 'The pattern from the previous pass applies here too. '.repeat(1 + (index % 4)),
    })
  }
  if (step === 2 || step === 3) {
    return item({
      kind: 'tool_call',
      name: 'Read',
      input: { file_path: `/repo/src/module-${index}/index.ts` },
      parentToolUseId: null,
      status: 'settled',
      result: {
        text: Array.from({ length: 1 + (index % 5) }, (unused, l) => `line ${l + 1} of the output`).join('\n'),
        isError: false,
      },
    })
  }
  if (step === 4) {
    return item({
      kind: 'tool_call',
      name: 'Edit',
      input: { file_path: `/repo/src/module-${index}/index.ts`, old_string: 'a', new_string: 'b' },
      parentToolUseId: null,
      status: 'settled',
      result: { text: `module-${index}: updated`, isError: false },
    })
  }
  return item({ kind: 'turn_result', subtype: 'success', isError: false, durationMs: 30_000 + index * 10, totalCostUsd: 0.05 })
})

// ~10× `huge` with far heavier rows: what `__wdPerf()` sweeps, deliberately bigger than any real session.
const perf: TranscriptItem[] = Array.from({ length: 4000 }, (_, index) => {
  const turn = Math.floor(index / 10)
  switch (index % 10) {
    case 0: {
      return item({
        kind: 'user',
        text: `Task ${turn}: review the module, refactor what you find, and summarise. ${'Keep the diff reviewable. '.repeat(1 + (turn % 3))}`,
      })
    }
    case 1: {
      return item({
        kind: 'thinking',
        text: `Thought for ${3 + (turn % 20)}s about module ${turn} and its ${1 + (turn % 7)} call sites`,
        parentToolUseId: null,
      })
    }
    case 2: {
      return item({
        kind: 'assistant_text',
        streaming: false,
        parentToolUseId: null,
        text: Array.from({ length: 3 + (turn % 4) }, (unused, s) =>
          Array.from({ length: 4 }, (unused2, l) =>
            `stanza ${s + 1} line ${l + 1} of note ${turn}, ${'holding steady '.repeat(1 + ((s + l) % 3))}`.trim(),
          ).join('\n'),
        ).join('\n\n'),
      })
    }
    case 3:
    case 4: {
      return item({
        kind: 'tool_call',
        name: 'Bash',
        input: { command: `pnpm --filter @workerdeck/mod-${index} test`, description: `Test module ${index}` },
        parentToolUseId: null,
        status: 'settled',
        result: {
          text: Array.from({ length: 2 + (index % 6) }, (unused, l) => `✓ case ${l + 1} passed (${l * 7}ms)`).join('\n'),
          isError: false,
        },
      })
    }
    case 5: {
      return item({
        kind: 'tool_call',
        name: 'Read',
        input: { file_path: `/repo/src/module-${turn}/index.ts` },
        parentToolUseId: null,
        status: 'settled',
        result: {
          text: Array.from({ length: 20 + (turn % 30) }, (unused, l) => `${l + 1}  export const symbol${l} = build(${l})`).join('\n'),
          isError: false,
        },
      })
    }
    case 6: {
      return item({
        kind: 'tool_call',
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
    }
    case 7: {
      return item({
        kind: 'assistant_text',
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
    }
    case 8: {
      return turn % 7 === 3
        ? item({ kind: 'notice', level: 'error', text: `module ${turn}: transient watcher error, retried once` })
        : item({ kind: 'assistant_text', streaming: false, parentToolUseId: null, text: `Module ${turn} done; moving on.` })
    }
    default: {
      return item({
        kind: 'turn_result',
        subtype: turn % 11 === 5 ? 'error_during_execution' : 'success',
        isError: turn % 11 === 5,
        durationMs: 20_000 + turn * 17,
        totalCostUsd: 0.03,
        ...(turn % 11 === 5 ? { errors: ['interrupted'] } : {}),
      })
    }
  }
})

// Adversarial on purpose: long unbroken tokens, CJK, emoji, combining marks, tabs, a wide table, a deep diff — the height audit's input.
const adversarial: TranscriptItem[] = [
  // A result far bigger than the expanded row's budget: it must clip and offer the rest.
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
  item({
    kind: 'user',
    text: 'Wrap model against the wall: a token that cannot break anywhere, wide glyphs, tables.\n\n第二段是中文的，全部都是宽字符，还混了一个 emoji 🎉 以及组合字符 é（e + U+0301）。',
  }),
  item({
    kind: 'assistant_text',
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
  item({ kind: 'thinking', text: 'Considering 👩‍💻 a ZWJ sequence and a naïve café — combining marks résumé…', parentToolUseId: null }),
  item({
    kind: 'tool_call',
    name: 'Read',
    input: {
      file_path:
        '/Users/atomic/projects/silkweave/packages/deeply/nested/with-a-very-long-single-component-file-name-that-cannot-break-anywhere-at-all.generated.ts',
    },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: 'line one\tafter a tab\naverylongunbrokenidentifierthatkeepsgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoingandgoing = 1\n中文输出行，包含宽字符\n\nlast line after an empty one',
      isError: false,
    },
  }),
  item({
    kind: 'tool_call',
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
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm typecheck' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'done in 4.2s', isError: false },
  }),
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm lint' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'ok', isError: false },
  }),
  item({
    kind: 'notice',
    level: 'info',
    text: 'Long notice with an unbreakable middle: /var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T/workerdeck-attachments-4f6a2c1e9b7d filled the line.',
  }),
  item({
    kind: 'file_delivered',
    path: 'reports/quarterly-summary-with-a-longer-than-usual-name.pdf',
    bytes: 2_400_000,
    description: 'Generated from the fixture data',
  }),
  item({
    kind: 'turn_result',
    subtype: 'error_during_execution',
    isError: true,
    durationMs: 63_000,
    totalCostUsd: 0.92,
    errors: [
      'A very long error message that will certainly wrap at every width under test because it keeps enumerating the things that went wrong, one after another, without a single break-friendly token boundary of unusual kind',
    ],
  }),
]

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

function withId(id: string, draft: ItemDraft): TranscriptItem {
  return { ...draft, id } as TranscriptItem
}

const subagents: TranscriptItem[] = [
  item({ kind: 'user', text: 'Find every place we parse a permission mode, and check the docs match.' }),
  item({
    kind: 'assistant_text',
    text: 'Two searches in parallel — one over the engines, one over the docs.',
    streaming: false,
    parentToolUseId: null,
  }),
  withId('toolu_A', {
    kind: 'tool_call',
    name: 'Task',
    input: { subagent_type: 'Explore', description: 'permission mode parsing' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: 'Four sites; two of them normalise, two do not.', isError: false },
  }),
  withId('toolu_B', {
    kind: 'tool_call',
    name: 'Task',
    input: { subagent_type: 'general-purpose', description: 'docs parity for permission modes' },
    parentToolUseId: null,
    status: 'running',
  }),
  item({ kind: 'user', text: 'Search the engines for permission mode parsing.', parentToolUseId: 'toolu_A' }),
  item({ kind: 'user', text: 'Check docs/ for permission mode claims.', parentToolUseId: 'toolu_B' }),
  item({
    kind: 'tool_call',
    name: 'Grep',
    input: { pattern: 'permissionMode' },
    parentToolUseId: 'toolu_A',
    status: 'settled',
    result: { text: 'packages/core/src/engines/claude/runner.ts:461\npackages/server/src/routes.ts:88', isError: false },
  }),
  item({
    kind: 'tool_call',
    name: 'Glob',
    input: { pattern: 'docs/**/*.md' },
    parentToolUseId: 'toolu_B',
    status: 'settled',
    result: { text: 'docs/GOTCHAS.md\ndocs/ARCHITECTURE.md', isError: false },
  }),
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'git status --short' },
    parentToolUseId: null,
    status: 'settled',
    result: { text: ' M packages/core/src/engines/claude/runner.ts', isError: false },
  }),
  item({
    kind: 'tool_call',
    name: 'Read',
    input: { file_path: 'packages/server/src/routes.ts' },
    parentToolUseId: 'toolu_A',
    status: 'settled',
    result: { text: 'export function routes() { /* … */ }', isError: false },
  }),
  item({
    kind: 'tool_call',
    name: 'Grep',
    input: { pattern: 'bypassPermissions' },
    parentToolUseId: 'toolu_B',
    status: 'failed',
    result: { text: 'No matches found', isError: true },
  }),
  item({
    kind: 'assistant_text',
    text: 'Four call sites. Two normalise the mode, two take it verbatim.',
    streaming: false,
    parentToolUseId: 'toolu_A',
  }),
  // Orphan: `toolu_GONE` is nowhere in this slice.
  item({
    kind: 'tool_call',
    name: 'Read',
    input: { file_path: 'docs/GOTCHAS.md' },
    parentToolUseId: 'toolu_GONE',
    status: 'settled',
    result: { text: '§Permission modes …', isError: false },
  }),
  item({
    kind: 'assistant_text',
    text: 'The engines agree; `docs/GOTCHAS.md` still describes the pre-normalisation behaviour.',
    streaming: false,
    parentToolUseId: null,
  }),
]

// The playground supplies no image loader, so every box settles into its failure state — deliberate: all three states are one box of `IMAGE_BOX_LINES`.
const images: TranscriptItem[] = [
  item({ kind: 'user', text: 'Look at the three mockups and tell me which one holds up.' }),
  item({
    kind: 'tool_call',
    name: 'Read',
    input: { file_path: 'design/mockup-a.png' },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: 'Read image design/mockup-a.png (1440x900)',
      isError: false,
      images: [{ partIndex: 1, mediaType: 'image/png', bytes: 344_064, sourceSeq: 41 }],
    },
  }),
  item({
    kind: 'assistant_text',
    text: 'The first holds up. Pulling the other two so they can be compared side by side:',
    streaming: false,
    parentToolUseId: null,
  }),
  item({
    kind: 'tool_call',
    name: 'mcp__chrome-devtools__take_screenshot',
    input: { fullPage: true },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: 'Captured 2 viewports',
      isError: false,
      images: [
        { partIndex: 0, mediaType: 'image/jpeg', bytes: 511_000, sourceSeq: 44 },
        { partIndex: 2, mediaType: 'image/webp', bytes: 96_500, sourceSeq: 44 },
      ],
    },
  }),
  item({
    kind: 'tool_call',
    name: 'Bash',
    input: { command: 'pnpm exec vitest run --reporter verbose' },
    parentToolUseId: null,
    status: 'settled',
    result: {
      text: Array.from({ length: 120 }, (_, i) => ` ✓ packages/ui/test/case ${i + 1} (${i * 2}ms)`).join('\n'),
      isError: false,
      // A picture after the text budget ran out: stored at index 7 and still addressed as 7, not by where it landed.
      images: [{ partIndex: 7, mediaType: 'image/png', bytes: 12_288, sourceSeq: 51 }],
    },
  }),
  item({
    kind: 'assistant_text',
    text: 'Mockup A. The other two lose the header at narrow widths.',
    streaming: false,
    parentToolUseId: null,
  }),
]

export const FIXTURES: { key: string; label: string; state: TranscriptState }[] = [
  { key: 'subagents', label: 'subagents (interleaved)', state: base(subagents, 'running') },
  { key: 'run', label: 'live run', state: base(run, 'running') },
  { key: 'diff', label: 'file edit', state: base(diff, 'idle') },
  { key: 'markdown', label: 'markdown', state: base(markdown, 'idle') },
  { key: 'failure', label: 'failure', state: base(failure, 'idle') },
  { key: 'long', label: 'long run', state: base(long, 'idle') },
  { key: 'huge', label: 'huge (600 rows)', state: base(huge, 'idle') },
  { key: 'perf', label: 'perf (4k items)', state: base(perf, 'idle') },
  { key: 'adversarial', label: 'adversarial (spike)', state: base(adversarial, 'idle') },
  { key: 'images', label: 'image refs', state: base(images, 'idle') },
  {
    key: 'approval',
    label: 'pending approval',
    state: { ...base(run, 'running'), pendingApprovals: [BASH_APPROVAL] },
  },
  { key: 'empty', label: 'empty', state: base([], 'idle') },
]
