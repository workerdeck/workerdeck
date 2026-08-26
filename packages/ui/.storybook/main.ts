import type { StorybookConfig } from '@storybook/react-vite'
import { defaultClientConditions } from 'vite'

/**
 * The component catalog.
 *
 * Separate from `dev/`, which stays what it always was: a *measurement* harness
 * for the terminal renderer (the character-cell overlay, the height audit, the
 * perf sweep). Those answer "is this on the grid", which is a question about one
 * running surface and not about a component's states. This answers "does every
 * state of this component look right, in both themes, at sidebar width", which
 * is a question `dev/` could only ever answer by growing a second app inside
 * itself.
 *
 * Nothing here is published — `package.json`'s `files` is `build` + `src`.
 */
const config: StorybookConfig = {
  stories: ['../stories/**/*.stories.@(ts|tsx)'],
  framework: { name: '@storybook/react-vite', options: {} },
  viteFinal: async (config) => {
    // Sibling workspace packages resolve to their sources, as every other dev
    // entry in this repo does — no build step between an edit and the story.
    config.resolve = config.resolve ?? {}
    config.resolve.conditions = ['@workerdeck/source', ...defaultClientConditions]
    return config
  },
}
export default config
