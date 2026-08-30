import type { StorybookConfig } from '@storybook/react-vite'
import { defaultClientConditions } from 'vite'

/**
 * The component catalog — component states in both themes, as opposed to `dev/`,
 * which measures one running terminal surface against the grid.
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
