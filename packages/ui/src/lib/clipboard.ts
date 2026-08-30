/**
 * Copy text to the clipboard, on origins where the modern API does not exist.
 *
 * `navigator.clipboard` is gated on a **secure context**: HTTPS, or localhost.
 * A WorkerDeck dashboard reached the way it is meant to be reached — plain HTTP
 * on a LAN address, from a laptop or a phone — is neither, so `navigator.clipboard`
 * is `undefined` there and touching `.writeText` throws outright. That is the
 * normal deployment, not an edge case, which is why this falls back rather than
 * feature-detecting into a disabled button.
 *
 * The fallback is `document.execCommand('copy')` over an off-screen textarea.
 * It is deprecated and it is also the only thing that works here; every browser
 * still implements it. Returns whether the text actually landed, so a caller can
 * avoid claiming success it did not have.
 */
export async function copyText(value: string): Promise<boolean> {
  // Optional-chained, not `in`-checked: on an insecure origin the property is
  // absent entirely, and some embedded webviews expose a `clipboard` object
  // whose `writeText` rejects. Both end up in the fallback.
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

function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  // Off-screen rather than hidden: `display: none` and `visibility: hidden`
  // elements cannot hold a selection, so the copy would silently do nothing.
  // `readOnly` keeps the mobile keyboard from appearing for the instant it exists.
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  // Preserve where the user was: selecting steals the current selection, and on
  // a text field mid-edit that is visible and annoying.
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
