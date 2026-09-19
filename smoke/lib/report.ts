// The one step reporter for the smoke scripts: three of them hand-rolled the same green/red lines
// with different glyphs, and each owned its own exit code.
const ESC = '\u001b['
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const GREEN = `${ESC}32m`
const RED = `${ESC}31m`
const YELLOW = `${ESC}33m`
const RESET = `${ESC}0m`

let passed = 0
let failed = 0

function line(glyph: string, what: string, detail?: string): string {
  return `  ${glyph} ${what}${detail ? ` ${DIM}${detail}${RESET}` : ''}`
}

export function step(what: string): void {
  console.log(`\n${BOLD}${what}${RESET}`)
}

export function ok(what: string, detail?: string): void {
  passed += 1
  console.log(line(`${GREEN}✓${RESET}`, what, detail))
}

export function fail(what: string, detail?: string): void {
  failed += 1
  console.error(line(`${RED}✗${RESET}`, what, detail))
}

export function warn(what: string, detail?: string): void {
  console.log(line(`${YELLOW}!${RESET}`, what, detail))
}

export function note(text: string): void {
  console.log(`  ${DIM}- ${text}${RESET}`)
}

export function failures(): number {
  return failed
}

export function finish(closing?: { onPass?: string; onFail?: string }): never {
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    if (closing?.onFail) {
      console.error(`${RED}${closing.onFail}${RESET}`)
    }
    process.exit(1)
  }
  if (closing?.onPass) {
    console.log(closing.onPass)
  }
  process.exit(0)
}
