import { readPref, writePref } from './storage.ts'

export type Theme = 'light' | 'dark'

const KEY = 'workerdeck.theme'

export function getTheme(): Theme {
  const stored = readPref(KEY)
  if (stored === 'light' || stored === 'dark') {
    return stored
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme = getTheme()): void {
  return document.documentElement.setAttribute('data-theme', theme)
}

export function setTheme(theme: Theme): void {
  writePref(KEY, theme)
  applyTheme(theme)
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}
