import type { ProfileAccount } from './index.ts'

export const ACCOUNT_EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000

export type AccountExpiry = 'valid' | 'expiring' | 'expired'

export function accountExpiry(account: ProfileAccount, now = Date.now()): AccountExpiry {
  const left = Date.parse(account.expiresAt) - now
  if (!(left > 0)) {
    return 'expired'
  }
  return left < ACCOUNT_EXPIRY_WARNING_MS ? 'expiring' : 'valid'
}
