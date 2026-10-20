import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './files.css'
import { Bridge } from '../bridge.ts'
import { FilesApp } from './FilesApp.tsx'

// The theme and root arrive with `wd-ready`'s answer, before React has mounted.
const bridge = new Bridge(['wd-files-root', 'wd-files-theme', 'wd-files-decorations'])

const root = document.getElementById('root')
if (!root) {
  throw new Error('Root element #root not found')
}

createRoot(root).render(
  <StrictMode>
    <FilesApp bridge={bridge} />
  </StrictMode>,
)
