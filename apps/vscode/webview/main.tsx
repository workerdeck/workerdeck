import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { Bridge } from './bridge.ts'
import { syncVsCodeTheme } from './theme.ts'
import { App } from './App.tsx'

syncVsCodeTheme()
const bridge = new Bridge(['wd-show-session'])

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

const density = root.dataset.density === 'compact' ? 'compact' : 'comfortable'
const variant = root.dataset.variant === 'cards' ? 'cards' : 'terminal'
const terminalMetrics = {
  fontSize: Number(root.dataset.fontSize) || undefined,
  lineHeight: Number(root.dataset.lineHeight) || undefined,
}
const affordances = root.dataset.affordances !== 'off'
const midTurnSend = root.dataset.catchUp === 'off' ? 'hold' : 'fold'
const panelFontSize = Number(root.dataset.panelFontSize) || undefined

createRoot(root).render(
  <StrictMode>
    <App
      bridge={bridge}
      density={density}
      variant={variant}
      midTurnSend={midTurnSend}
      terminalMetrics={terminalMetrics}
      affordances={affordances}
      fontSize={panelFontSize}
    />
  </StrictMode>,
)
