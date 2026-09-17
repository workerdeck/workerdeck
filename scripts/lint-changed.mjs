#!/usr/bin/env node
// The ratchet: `pnpm lint` holds the whole tree to wd/no-jsdoc, but wd/max-comment-lines is a
// warning there because its backlog is unswept. Here, over changed files only, warnings are
// failures, so new prose cannot land while the existing prose is dealt with separately. The
// em-dash ban rides the same ratchet for the same reason.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const LINT_EXT = /\.(ts|tsx|mjs|js|jsx)$/
// Every text file, because the em-dash backlog is mostly markdown and Swift, which oxlint
// cannot see. One scan covers what four linters would not.
const TEXT_EXT = /\.(ts|tsx|mjs|mts|js|jsx|md|swift|astro|css|html|json|ya?ml|sh|svg)$/
const EM_DASH = '\u2014'
const EN_DASH = '\u2013'
const DASHES = [EM_DASH, EN_DASH]
// A line may keep one where the character is data rather than prose: a fixture quoting an
// engine's own output, say. Mark the line and say why in review.
const EM_DASH_OPT_OUT = 'wd-em-dash-ok'

function changedFiles(pattern) {
  const out = new Set()
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR'],
    ['diff', '--name-only', '--cached', '--diff-filter=ACMR'],
  ]) {
    for (const line of execFileSync('git', args, { encoding: 'utf8' }).split('\n')) {
      if (line && pattern.test(line)) {
        out.add(line)
      }
    }
  }
  return [...out]
}

const emDashHits = []
for (const file of changedFiles(TEXT_EXT)) {
  let body
  try {
    body = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  body.split('\n').forEach((line, i) => {
    if (DASHES.some((dash) => line.includes(dash)) && !line.includes(EM_DASH_OPT_OUT)) {
      emDashHits.push(`${file}:${i + 1}: ${line.trim()}`)
    }
  })
}
if (emDashHits.length > 0) {
  process.stderr.write(`${emDashHits.join('\n')}\n`)
  process.stderr.write(
    `\nNo em or en dashes (${EM_DASH} ${EN_DASH}) in this project: use a comma, or a plain '-' where\n` +
      `a dash is really wanted. See docs/CODE-STYLE.md. Errors on files you changed; the tree\n` +
      `is swept separately. A line where the character is data can carry '${EM_DASH_OPT_OUT}'.\n`,
  )
  process.exit(1)
}

const files = changedFiles(LINT_EXT)
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
