import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { Bridge } from './bridge.ts'
import { syncVsCodeTheme } from './theme.ts'
import { App } from './App.tsx'

syncVsCodeTheme()
const bridge = new Bridge(['wd-show-session'])

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

// Stamped by the provider from settings, and read here rather than awaited over
// the bridge: between them the variant and the density decide every row's shape
// and height, so the first paint has to have both. A change re-renders this HTML.
const density = root.dataset.density === 'compact' ? 'compact' : 'comfortable'
const variant = root.dataset.variant === 'cards' ? 'cards' : 'terminal'
// The terminal theme's cell, resolved host-side against the editor's own font
// size. Whole pixels by the time it gets here; `Number` only has to survive the
// attribute round-trip.
const terminalMetrics = {
  fontSize: Number(root.dataset.fontSize) || undefined,
  lineHeight: Number(root.dataset.lineHeight) || undefined,
}
const affordances = root.dataset.affordances !== 'off'
// The panel-wide base font size, resolved host-side against the editor's own
// font size. Drives both variants — terminal (as the default cell size) and
// cards (as the panel root's font-size).
const panelFontSize = Number(root.dataset.panelFontSize) || undefined

createRoot(root).render(
  <StrictMode>
    <App
      bridge={bridge}
      density={density}
      variant={variant}
      terminalMetrics={terminalMetrics}
      affordances={affordances}
      fontSize={panelFontSize}
    />
  </StrictMode>,
)
