#!/usr/bin/env node
// The ratchet: `pnpm lint` holds the whole tree to wd/no-jsdoc, but wd/max-comment-lines is a
// warning there because its backlog is unswept. Here — over changed files only — warnings are
// failures, so new prose cannot land while the existing prose is dealt with separately.
import { execFileSync } from 'node:child_process'

const EXT = /\.(ts|tsx|mjs|js|jsx)$/

function changedFiles() {
  const out = new Set()
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR'],
    ['diff', '--name-only', '--cached', '--diff-filter=ACMR'],
  ]) {
    for (const line of execFileSync('git', args, { encoding: 'utf8' }).split('\n')) {
      if (line && EXT.test(line)) {
        out.add(line)
      }
    }
  }
  return [...out]
}

const files = changedFiles()
if (files.length === 0) {
  process.exit(0)
}

// Only the comment rules are escalated. Failing on every warning would re-create the fatigue this
// exists to prevent: a file's unrelated pre-existing warnings would drown the one new signal.
const COMMENT_RULES = /wd\((no-jsdoc|max-comment-lines)\)/

let text = ''
try {
  text = execFileSync('pnpm', ['exec', 'oxlint', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  text = (error.stdout ?? '') + (error.stderr ?? '')
}

const offenders = text.split('\n').filter((line) => COMMENT_RULES.test(line))
if (offenders.length > 0) {
  process.stderr.write(`${offenders.join('\n')}\n`)
  process.stderr.write(
    '\nComment rules are errors on files you changed, warnings elsewhere.\n' +
      'Read docs/CODE-STYLE.md § Comments: avoid comments entirely, prefer // over /**, and move\n' +
      'anything that would read naturally in a design doc into docs/ instead.\n',
  )
  process.exit(1)
}
