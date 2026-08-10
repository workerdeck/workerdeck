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

createRoot(root).render(
  <StrictMode>
    <App bridge={bridge} />
  </StrictMode>,
)
