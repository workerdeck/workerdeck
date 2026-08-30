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
  - `wd/max-comment-lines` (warn) — a comment block over 12 lines is documentation that belongs
    in `docs/` with a one-line pointer left behind.

## Conventions the tooling cannot (yet) enforce

- **Comments: as few as possible.** Documentation should be readable from the code itself and
  from `docs/` — not from comment blocks. Delete narrating comments; keep only what the code
  cannot say.
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
