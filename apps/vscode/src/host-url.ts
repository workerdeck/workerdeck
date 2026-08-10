/**
 * Pure URL logic for gateway hosts — the iOS `Host.apiURL` rules, ported.
 * Deliberately vscode-free so it loads (and smokes) outside the editor.
 */
export type HostUrl = { baseUrl: string }

/** Normalized REST base for `WorkerDeckClient`, or undefined if unparseable. */
export function apiUrl(host: HostUrl): string | undefined {
  let text = host.baseUrl.trim()
  while (text.endsWith('/')) text = text.slice(0, -1)
  if (text === '') return undefined
  // A bare `mac.tailnet.ts.net:8787` is a host:port, not a scheme — tailnet
  // gateways are plain http, so that is the sane default to assume.
  if (!text.includes('://')) text = 'http://' + text
  if (!text.endsWith('/v1')) text += '/v1'
  try {
    // Validation only — the string, not the URL object, is what we keep.
    new URL(text)
  } catch {
    return undefined
  }
  return text
}

/**
 * Whether this gateway is the machine the extension host runs on. Decided from
 * the URL, never by probing paths for existence — two checkouts of the same
 * repo would lie. In a Remote SSH window the extension host runs on the remote
 * box, so "loopback" correctly means *that* machine and transcript paths open
 * as real files there.
 */
export function isLoopbackHost(host: HostUrl): boolean {
  const api = apiUrl(host)
  if (!api) return false
  try {
    const { hostname } = new URL(api)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}
