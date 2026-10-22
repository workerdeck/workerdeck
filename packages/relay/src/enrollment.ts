import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RELAY_GATEWAY_NAME, RELAY_OWNER_NAME } from '@workerdeck/relay-client'

// No `owners` means the relay's default owner, resolved when read.
export type Enrollment = { hash: string; enrolledAt: number; owners?: string[] }

export type EnrollOptions = { rotate?: boolean; owner?: string; owners?: string[] }

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

export function checkOwners(owners: readonly string[]): string | null {
  if (owners.length === 0) {
    return 'name at least one owner'
  }
  return owners.map(checkOwnerName).find((invalid) => invalid !== null) ?? null
}

export function parseOwners(list: string): string[] {
  return [
    ...new Set(
      list
        .split(',')
        .map((owner) => owner.trim())
        .filter(Boolean),
    ),
  ]
}

export function ownersOf(enrollment: Enrollment | undefined, fallback: string): string[] {
  return enrollment?.owners ?? [fallback]
}

export function checkKeyHash(hash: string): string | null {
  return /^[0-9a-f]{64}$/.test(hash) ? null : 'a key hash is the 64 hex digit SHA-256 that `keygen` prints'
}

export async function readEnrollments(stateDir: string): Promise<EnrollmentFile> {
  const path = enrollmentPath(stateDir)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, gateways: {} }
    }
    throw error
  }
  const parsed = JSON.parse(text) as { version?: unknown; gateways?: unknown }
  if (parsed.version !== 1 || !parsed.gateways || typeof parsed.gateways !== 'object' || Array.isArray(parsed.gateways)) {
    throw new Error(`${path} is not an enrollment file this relay can read`)
  }
  const gateways: Record<string, Enrollment> = {}
  for (const [name, entry] of Object.entries(parsed.gateways as Record<string, unknown>)) {
    const enrollment = readEnrollment(entry)
    if (checkGatewayName(name) !== null || !enrollment) {
      throw new Error(`${path}: gateway ${name} was enrolled by WorkerDeck before 4.0.0 or is malformed; migrate the file first`)
    }
    gateways[name] = enrollment
  }
  return { version: 1, gateways }
}

function readEnrollment(value: unknown): Enrollment | undefined {
  const entry = value as Partial<Record<string, unknown>> | null
  if (!entry || typeof entry !== 'object' || !isHash(entry.hash) || typeof entry.enrolledAt !== 'number') {
    return undefined
  }
  if (Object.keys(entry).some((key) => key !== 'hash' && key !== 'enrolledAt' && key !== 'owners')) {
    return undefined
  }
  if (entry.owners === undefined) {
    return { hash: entry.hash, enrolledAt: entry.enrolledAt }
  }
  const owners = entry.owners
  if (!Array.isArray(owners) || owners.length === 0 || !owners.every((owner) => typeof owner === 'string' && checkOwnerName(owner) === null)) {
    return undefined
  }
  return { hash: entry.hash, enrolledAt: entry.enrolledAt, owners: [...new Set(owners as string[])] }
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function withOwners(hash: string, enrolledAt: number, owners: readonly string[] | undefined): Enrollment {
  return owners && owners.length > 0 ? { hash, enrolledAt, owners: [...owners] } : { hash, enrolledAt }
}

async function writeEnrollments(stateDir: string, file: EnrollmentFile): Promise<void> {
  const path = enrollmentPath(stateDir)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: file.version, gateways: file.gateways }, null, 2)}\n`, { mode: 0o600 })
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
  if (options.owner !== undefined && options.owners !== undefined) {
    throw new Error('pass --owner or --owners, not both')
  }
  const requested = options.owners ?? (options.owner === undefined ? undefined : [options.owner])
  const invalid = checkGatewayName(name) ?? (requested === undefined ? null : checkOwners(requested))
  if (invalid) {
    throw new Error(invalid)
  }
  const file = await readEnrollments(stateDir)
  const previous = file.gateways[name]
  if (previous && !options.rotate) {
    throw new Error(`gateway ${name} is already enrolled; pass --rotate to issue a new key`)
  }
  const owners = requested ?? previous?.owners
  file.gateways[name] = withOwners(hash, Date.now(), owners)
  await writeEnrollments(stateDir, file)
}

export async function setGatewayOwner(stateDir: string, name: string, owner: string | undefined): Promise<boolean> {
  return setGatewayOwners(stateDir, name, owner === undefined ? undefined : [owner])
}

// Replaces the whole set. A running relay drops the rows of an owner that left it on its next reload.
export async function setGatewayOwners(stateDir: string, name: string, owners: readonly string[] | undefined): Promise<boolean> {
  const invalid = owners === undefined ? null : checkOwners(owners)
  if (invalid) {
    throw new Error(invalid)
  }
  const file = await readEnrollments(stateDir)
  const entry = file.gateways[name]
  if (!entry) {
    return false
  }
  file.gateways[name] = withOwners(entry.hash, entry.enrolledAt, owners)
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
