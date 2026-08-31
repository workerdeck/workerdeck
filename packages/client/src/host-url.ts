export type HostUrl = { baseUrl: string }

export function apiUrl(host: HostUrl): string | undefined {
  let text = host.baseUrl.trim()
  while (text.endsWith('/')) {
    text = text.slice(0, -1)
  }
  if (text === '') {
    return undefined
  }
  // A bare `mac.tailnet.ts.net:8787` is a host:port, not a scheme, and tailnet gateways are plain http.
  if (!text.includes('://')) {
    text = 'http://' + text
  }
  if (!text.endsWith('/v1')) {
    text += '/v1'
  }
  try {
    // Validation only — the string, not the URL object, is what we keep.
    new URL(text)
  } catch {
    return undefined
  }
  return text
}

export function isLoopbackHost(host: HostUrl): boolean {
  const api = apiUrl(host)
  if (!api) {
    return false
  }
  try {
    const { hostname } = new URL(api)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}
