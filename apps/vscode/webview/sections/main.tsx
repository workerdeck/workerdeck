import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { Bridge } from '../bridge.ts'
import { syncVsCodeTheme } from '../theme.ts'
import { SectionApp, type SectionKind } from './SectionApp.tsx'

syncVsCodeTheme()
// Both push kinds replay: a section view resolving late (user expands it after
// the session is long selected) must not render empty until the next poll.
const bridge = new Bridge(['wd-sidebar-state', 'wd-vitals'])

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

// Which section this view is — stamped onto the root element by the provider.
const kind = (root.dataset.view ?? 'info') as SectionKind

createRoot(root).render(
  <StrictMode>
    <SectionApp bridge={bridge} kind={kind} />
  </StrictMode>,
)
