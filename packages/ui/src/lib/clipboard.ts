/**
 * Copy text to the clipboard, with a fallback for insecure origins.
 *
 * `navigator.clipboard` requires a secure context (HTTPS or localhost), and a
 * dashboard on plain LAN HTTP — the normal deployment — has neither, so the
 * property is absent there. The deprecated `execCommand('copy')` over an
 * off-screen textarea is the only thing that works on those origins. Returns
 * whether the text actually landed.
 */
export async function copyText(value: string): Promise<boolean> {
  // Optional-chained, not `in`-checked: some embedded webviews expose a
  // `clipboard` object whose `writeText` rejects. Both paths hit the fallback.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Permission denied, or a webview that lied about having the API.
  }
  return legacyCopy(value)
}

const legacyCopy = (value: string): boolean => {
  if (typeof document === 'undefined') {
    return false
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  // Off-screen, not `display: none`/`visibility: hidden` — hidden elements
  // cannot hold a selection, so the copy would silently do nothing. `readonly`
  // keeps the mobile keyboard from appearing.
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  // Selecting steals the current selection; restore focus afterwards.
  const previous = document.activeElement
  try {
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
    if (previous instanceof HTMLElement) {
      previous.focus()
    }
  }
}
