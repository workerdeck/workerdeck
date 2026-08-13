/**
 * The check that keeps the theme honest.
 *
 * "Looks aligned" is not a property you can hold by eye across four fixtures,
 * three widths and a font-size slider — a 2px drift is invisible in one screen
 * and obvious only after twenty rows, by which point it is somewhere in the
 * middle of a CSS file. So the grid is asserted instead: every row, block and
 * blank inside the surface must start on a whole multiple of `--term-line` from
 * the surface's content top, and be a whole multiple tall.
 *
 * It has already earned its place twice — an unmapped `td` still carrying the
 * markdown renderer's `py-2` (23px rows in an 18px theme), and lists missing the
 * class the blank-line rule keys on.
 */

export type GridViolation = {
  kind: 'offset' | 'height'
  /** How far off the grid, in px. */
  by: number
  className: string
  text: string
}

export type GridReport = {
  line: number
  checked: number
  violations: GridViolation[]
}

const SELECTOR = '.term-row, .term-block, .term-blank, .term-li, tr'

/** How far `value` is from the nearest multiple of `step`. */
function offGrid(value: number, step: number): number {
  const remainder = ((value % step) + step) % step
  return Math.min(remainder, step - remainder)
}

export function auditGrid(surface: HTMLElement): GridReport {
  const style = getComputedStyle(surface)
  const line = Number.parseFloat(style.getPropertyValue('--term-line'))
  // From the content top, not the border box: the surface's own padding is a
  // whole line, but measuring from it makes the report independent of that.
  const top = surface.getBoundingClientRect().top + Number.parseFloat(style.paddingTop)
  const nodes = surface.querySelectorAll<HTMLElement>(SELECTOR)
  const violations: GridViolation[] = []
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').slice(0, 48)
    const start = offGrid(rect.top - top, line)
    // Tolerance is sub-pixel: this is looking for real drift (a stray padding,
    // a fractional line height), not for the last bit of a device-pixel ratio.
    if (start > 0.02) {
      violations.push({ kind: 'offset', by: Number(start.toFixed(2)), className: node.className, text })
      // One report per node: a row pushed off the grid is also the wrong height
      // more often than not, and the second line says nothing new.
      continue
    }
    const height = offGrid(rect.height, line)
    if (height > 0.02) {
      violations.push({ kind: 'height', by: Number(height.toFixed(2)), className: node.className, text })
    }
  }
  return { line, checked: nodes.length, violations }
}
