import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { Bridge } from '../bridge.ts'
import { syncVsCodeTheme } from '../theme.ts'
import { SidebarApp } from './SidebarApp.tsx'

syncVsCodeTheme()
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
