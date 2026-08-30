import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { Bridge } from '../bridge.ts'
import { syncVsCodeTheme } from '../theme.ts'
import { GatewaysApp } from './GatewaysApp.tsx'

syncVsCodeTheme()
// The host answers `wd-ready` before React has mounted and subscribed, and this
// view resolves late by design (collapsed in the manifest) — so its one push
// kind replays rather than leaving an empty list until a gateway changes.
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
