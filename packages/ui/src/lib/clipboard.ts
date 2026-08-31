export const copyText = async (value: string): Promise<boolean> => {
  // Optional-chained, not `in`-checked: some embedded webviews expose a `clipboard` object whose `writeText` rejects.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}
  return legacyCopy(value)
}

const legacyCopy = (value: string): boolean => {
  if (typeof document === 'undefined') {
    return false
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
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
