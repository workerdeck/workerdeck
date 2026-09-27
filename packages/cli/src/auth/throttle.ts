export type ThrottleOptions = { windowMs: number; maxFailuresPerIp: number; maxFailuresGlobal: number }

type FailureWindow = { count: number; windowStart: number }

// A global cap sits behind the per-IP one because rotating IPs is trivial over IPv6.
export type LoginThrottle = ThrottleOptions & { failures: Map<string, FailureWindow>; global: FailureWindow }

const PRUNE_ABOVE = 256

export function createLoginThrottle(options: ThrottleOptions): LoginThrottle {
  return { ...options, failures: new Map(), global: { count: 0, windowStart: 0 } }
}

export function ipBlockedMs(throttle: LoginThrottle, ip: string, now: number): number {
  return blockedMs(throttle.failures.get(ip), throttle.maxFailuresPerIp, throttle.windowMs, now)
}

export function loginBlockedMs(throttle: LoginThrottle, ip: string, now: number): number {
  return Math.max(ipBlockedMs(throttle, ip, now), blockedMs(throttle.global, throttle.maxFailuresGlobal, throttle.windowMs, now))
}

export function recordFailure(throttle: LoginThrottle, ip: string, now: number, countGlobally = true): void {
  const { failures, windowMs } = throttle
  if (failures.size > PRUNE_ABOVE) {
    for (const [key, entry] of failures) {
      if (now - entry.windowStart >= windowMs) {
        failures.delete(key)
      }
    }
  }
  const entry = failures.get(ip)
  if (entry === undefined || now - entry.windowStart >= windowMs) {
    failures.set(ip, { count: 1, windowStart: now })
  } else {
    entry.count += 1
  }
  if (!countGlobally) {
    return
  }
  if (now - throttle.global.windowStart >= windowMs) {
    throttle.global.count = 1
    throttle.global.windowStart = now
  } else {
    throttle.global.count += 1
  }
}

export function forgiveIp(throttle: LoginThrottle, ip: string): void {
  throttle.failures.delete(ip)
}

function blockedMs(entry: FailureWindow | undefined, max: number, windowMs: number, now: number): number {
  return entry !== undefined && entry.count >= max && now - entry.windowStart < windowMs ? entry.windowStart + windowMs - now : 0
}
