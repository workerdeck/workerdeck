import type { Decorator, Preview } from '@storybook/react-vite'
import { useEffect } from 'react'
import './preview.css'

// Theme is a toolbar global, not a story argument: half this package's tokens are
// declared on `:root`, so a scoped wrapper would not theme a story. `surface` is the
// same idea — a session card's fills were picked against the sidebar it ships on.
export const globalTypes = {
  theme: {
    description: 'Theme',
    toolbar: {
      title: 'Theme',
      icon: 'circlehollow',
      items: [
        { value: 'dark', title: 'Dark' },
        { value: 'light', title: 'Light' },
      ],
      dynamicTitle: true,
    },
  },
  surface: {
    description: 'Canvas the story sits on',
    toolbar: {
      title: 'Surface',
      icon: 'component',
      items: [
        { value: 'sidebar', title: 'Sidebar' },
        { value: 'bg', title: 'Editor' },
        { value: 'surface', title: 'Panel' },
      ],
      dynamicTitle: true,
    },
  },
}

const withTheme: Decorator = (Story, context) => {
  const theme = context.globals.theme ?? 'dark'
  const surface = context.globals.surface ?? 'sidebar'
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const fill = surface === 'sidebar' ? 'var(--sidebar)' : surface === 'bg' ? 'var(--bg)' : 'var(--bg-surface)'
  return (
    <div style={{ background: fill, color: 'var(--fg-1)', minHeight: '100vh', padding: 8 }}>
      <Story />
    </div>
  )
}

const preview: Preview = {
  initialGlobals: { theme: 'dark', surface: 'sidebar' },
  decorators: [withTheme],
  parameters: {
    layout: 'fullscreen',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
}
export default preview
