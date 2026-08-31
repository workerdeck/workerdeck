# Code style

The reference file for these rules is `packages/core/src/engines/claude/subagents.ts`. This is
a first set; it will grow. Anything the tooling can enforce, the tooling enforces — the goal is
that `pnpm format` + `pnpm lint --fix` converge the whole repo, and format-on-save keeps it there.

## Tooling

- **oxfmt** formats (`.oxfmtrc.json` at the root, `pnpm format` / `pnpm format:check`).
- **oxlint** lints (`oxlint.json` at the root, `pnpm lint`, `oxlint --fix` for autofixable rules).
- **VS Code**: the `oxc.oxc-vscode` extension (recommended in `.vscode/extensions.json`) is the
  default formatter for JS/TS with format-on-save enabled in `.vscode/settings.json`.

## Formatter-enforced (oxfmt)

- **No semicolons** (`semi: false`).
- **Single quotes** (`singleQuote: true`).
- **`printWidth: 140`** — long lines are fine; signatures and imports overwhelmingly stay on one
  line. Not higher: width is also the join threshold, and a wider limit collapses deliberately
  multi-line expressions into dense one-liners. 140 is the compromise — we never use
  `// oxfmt-ignore`.
- **Trailing commas in multi-line structures** (`trailingComma: "all"`). Single-line structures —
  which is what imports normally are at width 160 — never get one.
- 2-space indent, spaces not tabs.

## Lint-enforced (oxlint)

- **Always use curly braces**, including single-statement bodies (`curly: error`, autofixable).
  `if`/`else if` chains always take newlines and braces. `case` arms are always braced
  (`unicorn/switch-case-braces` — `curly` alone does not cover switch).
- **`import type` for type-only imports** (`typescript/consistent-type-imports`;
  `disallowTypeAnnotations` is off because vitest's `importOriginal<typeof import('m')>()` is
  idiomatic).
- **Custom rules** in `lint/wd-plugin.js` (loaded via `jsPlugins`):
  - `wd/module-func-style` — module-level helpers must be arrow-function consts; `function`
    declarations are reserved for PascalCase components and generators. Vendored code
    (`packages/ui/src/components/prompt-area`) is exempt — it keeps its upstream shape.
  - `wd/no-stacked-jsdoc` — two `/** */` blocks on one declaration is always a mistake: one of
    them documents the wrong symbol or went stale.
  - `wd/max-comment-lines` (warn) — a **smoke alarm only**, and a weak one: see § Comments below
    for the actual rule, which no line-count check can express. Vendored code
    (`packages/ui/src/components/prompt-area`) is exempt for the same reason it is exempt from
    `wd/module-func-style`, plus one of its own: most of those blocks are the upstream library's
    `@example` API docs, and rewriting them is pure diff noise against a tree we want to keep
    diffable. The few that carry WorkerDeck-added invariants stay at the call site deliberately —
    documenting vendored internals in our `docs/` is how the vendored boundary rots.

## Conventions the tooling cannot (yet) enforce

### Comments

**Avoid comments entirely.** Documentation lives in markdown; code carries the behaviour. A
comment is the exception and needs a positive reason, one of exactly two:

- A **single-line `//`** next to code, naming a specific complexity the code itself cannot
  express *and* that cannot be inferred from reading the surrounding lines.
- A **critical edge-case or gotcha** that has no other expression than a comment.

The supporting rules:

- **If better naming or structure removes the need for the comment, do that instead.** A comment
  explaining a variable is a bug report about its name.
- **Prefer `//` over `/**`**, including for multi-line comments. JSDoc blocks invite prose.
- **No file-header blocks, no `// ---- Section ----` banners, no per-symbol `docs/` pointers.**
  `CLAUDE.md`'s dispatcher table is how `docs/` is found; a pointer on every symbol is the same
  duplication in a smaller font.
- **Deleting a comment is not the end of the job.** If it carried critical information that is
  hard to derive from the code, or anything system-relevant (a status flow, a state machine, a
  lifecycle), it must reach `docs/` — and if it cannot be placed immediately, it goes in
  `_docs/DOC-DEBT.md` (gitignored scratch) so the next pass covers it, never straight to /dev/null. Be strict about what qualifies: most comments
  are restating the code and simply go.
- **Tests are held to the rule too**, with one allowance: a single-line `//` may stay where a
  fixture, a timing dependency or a scenario's setup is genuinely non-obvious from the test name.
  A comment that restates what the assertion already says still goes. (`**/test/**` is exempt from
  `wd/max-comment-lines` in `.oxlintrc.json`; that exemption is about the old line-count rule, not
  a licence for prose.)

Why the rule reads this way: an earlier attempt enforced "comments under 12 lines" with a lint
rule, and the threshold became the target. 58 blocks ended up at exactly 12 lines against 3 at 13,
each keeping its narrative and adding a `docs/` pointer to the doc that already told the same
story — strictly worse than either alone. Line count cannot express this rule; the test is
**"would this sentence read naturally in a design doc?"** If yes, it belongs in one.

The reference result is `packages/protocol/src/index.ts`: 2,144 lines and 1,199 comment lines
became 923 lines and **zero** comments, with no change to a single token of code.

### Structure and naming

- **Name types that carry meaning.** Define a named interface/type when the shape is meaningful,
  reused, or spans multiple lines. The exception is narrowing untrusted wire data: a one-off
  probe cast like `block as { tool_use_id?: unknown }` may stay inline — a named interface there
  would imply more certainty about the shape than exists.
- **Module-level `const`s at the top of the file** (after imports and type declarations).
- **Module-level helpers are arrow-function consts** on a single-line signature:
  `const fn = (a: string): R => { … }` — not `function` declarations. **PascalCase React
  components are the exception**: `export function Component()` is the repo's component form.
  (Both halves are enforced by `wd/module-func-style`.)
- **Keep function signatures on one line.** Width 160 makes this the default; don't hand-wrap.

## Known formatter tradeoff

Single-line braced guards (`if (!record) { continue }`) do not survive oxfmt — prettier
semantics always expand a braced block to three lines, and oxfmt has no plugin system to change
that. We accept the three-line form:

```ts
if (!record) {
  continue
}
```

If oxfmt grows extensibility, revisit.
