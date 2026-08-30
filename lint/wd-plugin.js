// WorkerDeck's own lint rules — the conventions docs/CODE-STYLE.md states that no
// off-the-shelf rule covers. Loaded via `jsPlugins` in .oxlintrc.json.

const isPascalCase = (name) => /^[A-Z]/.test(name)

/** Module-level helpers are arrow-function consts; `function` declarations are
 * reserved for PascalCase React components (and generators, which cannot be
 * arrows). docs/CODE-STYLE.md § Conventions. */
const moduleFuncStyle = {
  create(context) {
    const check = (node) => {
      const fn = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node
      if (!fn || fn.type !== 'FunctionDeclaration' || !fn.id || fn.generator) {
        return
      }
      if (isPascalCase(fn.id.name)) {
        return
      }
      context.report({
        node: fn.id,
        message: `Module-level helper '${fn.id.name}' must be an arrow-function const (docs/CODE-STYLE.md); 'function' declarations are for PascalCase components only.`,
      })
    }
    return {
      'Program > FunctionDeclaration': check,
      'Program > ExportNamedDeclaration': check,
      'Program > ExportDefaultDeclaration': check,
    }
  },
}

/** Two doc-comment blocks stacked on one declaration: one of them documents the
 * wrong symbol or is stale. Found attached to the wrong symbols six times in the
 * 2026-08 cleanup sweep. */
const noStackedJsdoc = {
  create(context) {
    return {
      'Program:exit'() {
        const comments = context.sourceCode.getAllComments()
        for (let i = 1; i < comments.length; i++) {
          const prev = comments[i - 1]
          const cur = comments[i]
          if (prev.type !== 'Block' || cur.type !== 'Block') {
            continue
          }
          if (!prev.value.startsWith('*') || !cur.value.startsWith('*')) {
            continue
          }
          const between = context.sourceCode.text.slice(prev.range[1], cur.range[0])
          if (/^\s*$/.test(between)) {
            context.report({
              loc: cur.loc,
              message: 'Stacked doc comments: two /** */ blocks on one declaration — merge them or delete the stale one.',
            })
          }
        }
      },
    }
  },
}

const MAX_COMMENT_LINES = 12

/** A comment longer than this is documentation wearing a comment's clothes — it
 * belongs in docs/ (GOTCHAS.md, PACKAGES.md, ...) with a one-line pointer here. */
const maxCommentLines = {
  create(context) {
    return {
      'Program:exit'() {
        const comments = context.sourceCode.getAllComments()
        let runStart
        let runEnd
        const flush = () => {
          if (runStart && runEnd && runEnd.loc.end.line - runStart.loc.start.line + 1 > MAX_COMMENT_LINES) {
            context.report({
              loc: runStart.loc,
              message: `Comment block exceeds ${MAX_COMMENT_LINES} lines — move the story to docs/ and keep the invariant sentence here.`,
            })
          }
          runStart = undefined
          runEnd = undefined
        }
        for (const c of comments) {
          if (runEnd && c.loc.start.line <= runEnd.loc.end.line + 1) {
            runEnd = c
            continue
          }
          flush()
          runStart = c
          runEnd = c
        }
        flush()
      },
    }
  },
}

const plugin = {
  meta: { name: 'wd' },
  rules: {
    'module-func-style': moduleFuncStyle,
    'no-stacked-jsdoc': noStackedJsdoc,
    'max-comment-lines': maxCommentLines,
  },
}

export default plugin
