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
const variant = root.dataset.variant === 'cards' ? 'cards' : 'lines'

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} density={density} variant={variant} />
  </StrictMode>,
)
