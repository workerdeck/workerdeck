import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './search.css'
import { Bridge } from '../bridge.ts'
import { SearchApp } from './SearchApp.tsx'

const bridge = new Bridge(['wd-search-root', 'wd-search-theme', 'wd-search-settings'])

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <SearchApp bridge={bridge} />
  </StrictMode>,
)
