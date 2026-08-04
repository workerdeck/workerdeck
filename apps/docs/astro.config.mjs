// @ts-check
import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages project site: https://<owner>.github.io/<repo>/. Override for a custom
// domain with DOCS_SITE (and DOCS_BASE='/') at build time.
const site = process.env.DOCS_SITE ?? 'https://workerdeck.github.io'
const base = process.env.DOCS_BASE ?? '/workerdeck'

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  redirects: {
    '/docs': '/docs/getting-started/introduction',
  },
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
