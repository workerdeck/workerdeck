#!/usr/bin/env node
// Deterministic half of the dash ban (docs/CODE-STYLE.md § Prose): rewrite every em and en dash
// to a plain '-', which the rule already sanctions, so nobody has to hand-punctuate a backlog.
// Default scope is the files you changed, matching scripts/lint-changed.mjs; --all sweeps the
// tree. A line carrying the opt-out marker is left alone, because there the character is data.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TEXT_EXT = /\.(ts|tsx|mjs|mts|js|jsx|md|swift|astro|css|html|json|ya?ml|sh|svg)$/
// The two characters the sweep hunts for, so this file always trips its own check.
const EM_DASH = '—' // wd-em-dash-ok
const EN_DASH = '–' // wd-em-dash-ok
const OPT_OUT = 'wd-em-dash-ok'
const ALL = process.argv.includes('--all')

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
}

function targets() {
  if (ALL) {
    return git(['ls-files']).filter((f) => TEXT_EXT.test(f))
  }
  const out = new Set()
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR'],
    ['diff', '--name-only', '--cached', '--diff-filter=ACMR'],
  ]) {
    for (const f of git(args)) {
      if (TEXT_EXT.test(f)) {
        out.add(f)
      }
    }
  }
  return [...out]
}

let files = 0
let lines = 0
for (const file of targets()) {
  let body
  try {
    body = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (!body.includes(EM_DASH) && !body.includes(EN_DASH)) {
    continue
  }
  let touched = 0
  const next = body
    .split('\n')
    .map((line) => {
      if (line.includes(OPT_OUT) || (!line.includes(EM_DASH) && !line.includes(EN_DASH))) {
        return line
      }
      touched++
      // ' - ' rather than a bare '-' where the dash was spaced: 'a - b' reads, 'a-b' hyphenates.
      return line.replaceAll(` ${EM_DASH} `, ' - ').replaceAll(` ${EN_DASH} `, ' - ').replaceAll(EM_DASH, '-').replaceAll(EN_DASH, '-')
    })
    .join('\n')
  if (next !== body) {
    writeFileSync(file, next)
    files++
    lines += touched
  }
}
console.log(ALL ? `swept the tree: ${lines} line(s) in ${files} file(s)` : `swept changed files: ${lines} line(s) in ${files} file(s)`)
