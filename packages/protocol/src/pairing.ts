// A pairing link is `https://<host>[:port]/#pair=<key>`: the key in the fragment never reaches a server or proxy log.
// Parsed by hand rather than with `URL`, which this package cannot assume, and step for step like the Rust core's
// `parse_pairing_link` (iOS and Android), so every client reads a link the same way.
export type PairingLink = { baseUrl: string; key: string }

export const PAIR_FRAGMENT = '#pair='

export function formatPairingLink(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${PAIR_FRAGMENT}${encodeURIComponent(key)}`
}

export function parsePairingLink(text: string): PairingLink | null {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith('https://') && !lower.startsWith('http://')) {
    return null
  }
  const hash = trimmed.indexOf('#')
  if (hash < 0 || !trimmed.startsWith(PAIR_FRAGMENT, hash)) {
    return null
  }
  let key: string
  try {
    key = decodeURIComponent(trimmed.slice(hash + PAIR_FRAGMENT.length))
  } catch {
    return null
  }
  if (key.length < 12 || !/^[\x21-\x7e]+$/.test(key)) {
    return null
  }
  const before = trimmed.slice(0, hash)
  const base = before.split('?', 1)[0]!.replace(/\/+$/, '')
  const separator = base.indexOf('://')
  const scheme = base.slice(0, separator).toLowerCase()
  const rest = base.slice(separator + 3)
  if (rest === '' || rest.startsWith('/') || /\s/.test(rest)) {
    return null
  }
  const slash = rest.indexOf('/')
  const authority = (slash < 0 ? rest : rest.slice(0, slash)).toLowerCase()
  const path = slash < 0 ? '' : rest.slice(slash + 1)
  const defaultPort = scheme === 'https' ? ':443' : ':80'
  const host = authority.endsWith(defaultPort) && authority.length > defaultPort.length ? authority.slice(0, -defaultPort.length) : authority
  return { baseUrl: path === '' ? `${scheme}://${host}` : `${scheme}://${host}/${path}`, key }
}
