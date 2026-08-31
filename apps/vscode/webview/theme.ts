export function syncVsCodeTheme(): void {
  const apply = () => {
    const cls = document.body.classList
    const dark = cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }
  apply()
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ['class'] })
}
