export function sessionWsUrl(baseUrl: string, sessionId: string, afterSeq: number, truncateResults = false, imageRefs = false): string {
  const query = `afterSeq=${afterSeq}` + (truncateResults ? '&truncateResults=1' : '') + (imageRefs ? '&imageRefs=1' : '')
  return `${baseUrl.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(sessionId)}/ws?${query}`
}
