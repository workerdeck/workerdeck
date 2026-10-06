import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RELAY_GATEWAY_NAME, RELAY_OWNER_NAME } from '@workerdeck/relay-client'

export type Enrollment = { hash: string; enrolledAt: number; owner?: string }

export type EnrollOptions = { rotate?: boolean; owner?: string }

export type EnrollmentFile = { version: 1; gateways: Record<string, Enrollment> }

export const ENROLLMENT_FILE = 'gateways.json'

export function enrollmentPath(stateDir: string): string {
  return join(stateDir, ENROLLMENT_FILE)
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function newGatewayKey(): string {
  return `wdr_${randomBytes(32).toString('base64url')}`
}

export function keyMatches(enrollment: Enrollment | undefined, key: string): boolean {
  const presented = Buffer.from(hashKey(key), 'hex')
  const stored = Buffer.from(enrollment?.hash ?? hashKey(''), 'hex')
  return presented.length === stored.length && timingSafeEqual(presented, stored) && enrollment !== undefined
}

export function checkGatewayName(name: string): string | null {
  return RELAY_GATEWAY_NAME.test(name)
    ? null
    : 'a gateway name is 1 to 63 lowercase letters, digits or dashes, starting with a letter or digit'
}

export function checkOwnerName(owner: string): string | null {
  return RELAY_OWNER_NAME.test(owner) ? null : 'an owner is 1 to 32 lowercase letters, digits or dashes'
}

export function checkKeyHash(hash: string): string | null {
  return /^[0-9a-f]{64}$/.test(hash) ? null : 'a key hash is the 64 hex digit SHA-256 that `keygen` prints'
}

export async function readEnrollments(stateDir: string): Promise<EnrollmentFile> {
  let text: string
  try {
    text = await readFile(enrollmentPath(stateDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, gateways: {} }
    }
    throw error
  }
  const parsed = JSON.parse(text) as Partial<EnrollmentFile>
  const gateways: Record<string, Enrollment> = {}
  for (const [name, entry] of Object.entries(parsed.gateways ?? {})) {
    if (checkGatewayName(name) === null && typeof entry?.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash)) {
      gateways[name] = {
        hash: entry.hash,
        enrolledAt: typeof entry.enrolledAt === 'number' ? entry.enrolledAt : 0,
        ...(typeof entry.owner === 'string' && checkOwnerName(entry.owner) === null ? { owner: entry.owner } : {}),
      }
    }
  }
  return { version: 1, gateways }
}

async function writeEnrollments(stateDir: string, file: EnrollmentFile): Promise<void> {
  const path = enrollmentPath(stateDir)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, path)
}

export async function enrollGateway(stateDir: string, name: string, options: EnrollOptions = {}): Promise<string> {
  const key = newGatewayKey()
  await enroll(stateDir, name, hashKey(key), options)
  return key
}

// For a key generated on the gateway's own machine (`keygen`): the relay stores the hash it is
// given and never sees the key.
export async function enrollGatewayHash(stateDir: string, name: string, hash: string, options: EnrollOptions = {}): Promise<void> {
  const invalid = checkKeyHash(hash)
  if (invalid) {
    throw new Error(invalid)
  }
  await enroll(stateDir, name, hash, options)
}

async function enroll(stateDir: string, name: string, hash: string, options: EnrollOptions): Promise<void> {
  const invalid = checkGatewayName(name) ?? (options.owner === undefined ? null : checkOwnerName(options.owner))
  if (invalid) {
    throw new Error(invalid)
  }
  const file = await readEnrollments(stateDir)
  const previous = file.gateways[name]
  if (previous && !options.rotate) {
    throw new Error(`gateway ${name} is already enrolled; pass --rotate to issue a new key`)
  }
  const owner = options.owner ?? previous?.owner
  file.gateways[name] = { hash, enrolledAt: Date.now(), ...(owner ? { owner } : {}) }
  await writeEnrollments(stateDir, file)
}

export async function setGatewayOwner(stateDir: string, name: string, owner: string | undefined): Promise<boolean> {
  const invalid = owner === undefined ? null : checkOwnerName(owner)
  if (invalid) {
    throw new Error(invalid)
  }
  const file = await readEnrollments(stateDir)
  const entry = file.gateways[name]
  if (!entry) {
    return false
  }
  file.gateways[name] = { hash: entry.hash, enrolledAt: entry.enrolledAt, ...(owner ? { owner } : {}) }
  await writeEnrollments(stateDir, file)
  return true
}

export async function writeKeyFile(path: string, options: { force?: boolean } = {}): Promise<string> {
  const key = newGatewayKey()
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${key}\n`, { mode: 0o600, flag: options.force ? 'w' : 'wx' })
  return hashKey(key)
}

export async function revokeGateway(stateDir: string, name: string): Promise<boolean> {
  const file = await readEnrollments(stateDir)
  if (!file.gateways[name]) {
    return false
  }
  delete file.gateways[name]
  await writeEnrollments(stateDir, file)
  return true
}
