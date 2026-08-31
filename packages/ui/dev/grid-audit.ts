export type GridViolation = {
  kind: 'offset' | 'height'
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

function offGrid(value: number, step: number): number {
  const remainder = ((value % step) + step) % step
  return Math.min(remainder, step - remainder)
}

export function auditGrid(surface: HTMLElement): GridReport {
  const style = getComputedStyle(surface)
  const line = Number.parseFloat(style.getPropertyValue('--term-line'))
  // From the content top, not the border box, so the report is independent of the surface's own padding.
  const top = surface.getBoundingClientRect().top + Number.parseFloat(style.paddingTop)
  const nodes = surface.querySelectorAll<HTMLElement>(SELECTOR)
  const violations: GridViolation[] = []
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').slice(0, 48)
    const start = offGrid(rect.top - top, line)
    // Sub-pixel tolerance: real drift, not device-pixel-ratio residue.
    if (start > 0.02) {
      violations.push({ kind: 'offset', by: Number(start.toFixed(2)), className: node.className, text })
      continue
    }
    const height = offGrid(rect.height, line)
    if (height > 0.02) {
      violations.push({ kind: 'height', by: Number(height.toFixed(2)), className: node.className, text })
    }
  }
  return { line, checked: nodes.length, violations }
}
