import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import './styles.css'
import { App } from './App.tsx'
import { queryClient } from './lib/trpc.ts'

const root = document.getElementById('root')
if (!root) {
  throw new Error('#root is missing from index.html')
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
