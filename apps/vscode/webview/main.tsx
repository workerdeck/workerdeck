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
// the bridge: density decides every row's height, so the first paint has to have
// it. A change re-renders this HTML.
const density = root.dataset.density === 'compact' ? 'compact' : 'comfortable'

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} density={density} />
  </StrictMode>,
)
