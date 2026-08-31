const moduleFuncStyle = {
  create(context) {
    const check = (node) => {
      const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node
      if (!decl || decl.type !== 'VariableDeclaration' || decl.kind !== 'const') {
        return
      }
      for (const declarator of decl.declarations) {
        if (declarator.id.type !== 'Identifier' || !declarator.init) {
          continue
        }
        if (declarator.init.type !== 'ArrowFunctionExpression' && declarator.init.type !== 'FunctionExpression') {
          continue
        }
        // An explicit annotation is the point of the declaration (FunctionComponent<Props> and
        // friends, or a JSDoc `@type` tag in .mjs): it types the BINDING, so converting would
        // throw the type away. Those stay consts.
        if (declarator.id.typeAnnotation) {
          continue
        }
        const leading = context.sourceCode.getCommentsBefore?.(node) ?? []
        if (leading.some((comment) => comment.type === 'Block' && /@type\b/.test(comment.value))) {
          continue
        }
        context.report({
          node: declarator.id,
          message: `Module-level '${declarator.id.name}' must be a 'function' declaration (docs/CODE-STYLE.md); arrow consts are for annotated bindings and non-module scope.`,
        })
      }
    }
    return {
      'Program > VariableDeclaration': check,
      'Program > ExportNamedDeclaration': check,
    }
  },
}

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
