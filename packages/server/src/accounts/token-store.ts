import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProfileAccount } from '@workerdeck/protocol'
import { isMissing, writeFileAtomicSync } from '../lib/atomic-file.ts'

export const ACCOUNT_FILE = 'workerdeck-account.json'
export const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

type StoredAccount = ProfileAccount & { token: string }

export function accountFile(configDir: string): string {
  return join(configDir, ACCOUNT_FILE)
}

function readStored(configDir: string): StoredAccount | undefined {
  let raw: string
  try {
    raw = readFileSync(accountFile(configDir), 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAccount>
    if (
      parsed.kind === 'setup-token' &&
      typeof parsed.token === 'string' &&
      typeof parsed.connectedAt === 'string' &&
      typeof parsed.expiresAt === 'string'
    ) {
      return parsed as StoredAccount
    }
  } catch {}
  return undefined
}

export function readAccount(configDir: string): ProfileAccount | undefined {
  const stored = readStored(configDir)
  return stored ? { kind: stored.kind, connectedAt: stored.connectedAt, expiresAt: stored.expiresAt } : undefined
}

export function readAccountToken(configDir: string): string | undefined {
  return readStored(configDir)?.token
}

export function writeAccount(configDir: string, token: string, now = new Date()): ProfileAccount {
  const account: ProfileAccount = {
    kind: 'setup-token',
    connectedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SETUP_TOKEN_LIFETIME_MS).toISOString(),
  }
  writeFileAtomicSync(accountFile(configDir), JSON.stringify({ ...account, token }, null, 2) + '\n')
  return account
}

export function deleteAccount(configDir: string): boolean {
  const existed = readStored(configDir) !== undefined
  rmSync(accountFile(configDir), { force: true })
  return existed
}
