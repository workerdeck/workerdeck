import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { Bridge } from '../bridge.ts'
import { syncVsCodeTheme } from '../theme.ts'
import { SidebarApp } from './SidebarApp.tsx'

syncVsCodeTheme()
// Navigation is deliberately not replayed: a re-resolved webview comes back to the list, not a stale form.
const bridge = new Bridge(['wd-sidebar-state', 'wd-vitals'])

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <SidebarApp bridge={bridge} />
  </StrictMode>,
)
