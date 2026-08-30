import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { Bridge } from '../bridge.ts'
import { syncVsCodeTheme } from '../theme.ts'
import { GatewaysApp } from './GatewaysApp.tsx'

syncVsCodeTheme()
// This view resolves late by design (collapsed in the manifest), so its push kind replays.
const bridge = new Bridge(['wd-gateways'])

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <GatewaysApp bridge={bridge} />
  </StrictMode>,
)
