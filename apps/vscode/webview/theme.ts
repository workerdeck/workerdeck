/**
 * `@workerdeck/ui` themes off `<html data-theme>`; VS Code stamps
 * `vscode-light`/`vscode-dark`/`vscode-high-contrast*` onto `<body>` and swaps it
 * live on theme change. Map one onto the other and keep it mapped.
 */
export const syncVsCodeTheme = (): void => {
  const apply = () => {
    const cls = document.body.classList
    const dark = cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }
  apply()
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] })
}
