export type Theme = 'light' | 'dark'

const KEY = 'workerdeck.theme'

export const getTheme = (): Theme => {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark') {
      return stored
    }
  } catch {
    // storage unavailable
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const applyTheme = (theme: Theme = getTheme()): void => document.documentElement.setAttribute('data-theme', theme)

export const setTheme = (theme: Theme): void => {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // storage unavailable
  }
  applyTheme(theme)
}

export const toggleTheme = (): Theme => {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}
