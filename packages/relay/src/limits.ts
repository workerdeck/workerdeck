export type RateLimiter = (key: string, limit: number, windowMs: number) => boolean

export type SendLimits = { maxChars: number; maxHops: number }

export function rateLimiter(now: () => number = Date.now): RateLimiter {
  const sent = new Map<string, number[]>()
  return (key, limit, windowMs) => {
    const at = now()
    const recent = (sent.get(key) ?? []).filter((time) => at - time < windowMs)
    const ok = recent.length < limit
    if (ok) {
      recent.push(at)
    }
    sent.set(key, recent)
    return ok
  }
}

export function sendRefusal(text: string, hops: number, limits: SendLimits): string | undefined {
  if (text.length === 0 || text.length > limits.maxChars) {
    return `message is ${text.length} characters; the limit is ${limits.maxChars}. Write it to a file and send the path.`
  }
  if (hops > limits.maxHops) {
    return `${hops} messages have passed between sessions without a person speaking; stop and ask your user before continuing.`
  }
  return undefined
}
