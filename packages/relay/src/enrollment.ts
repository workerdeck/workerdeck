import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RELAY_GATEWAY_NAME, RELAY_OWNER_NAME } from '@workerdeck/relay-client'

// `owners` holds two or more owners; one owner stays in `owner`, the layout older relays read.
export type Enrollment = { hash: string; enrolledAt: number; owner?: string; owners?: string[] }

export type EnrollOptions = { rotate?: boolean; owner?: string; owners?: string[] }

export type EnrollmentFile = { version: 1; gateways: Record<string, Enrollment> }

// On disk a record with several owners keeps its key hash here and has no `hash`, so an older relay, which reads only
// `owner`, finds no key and refuses the gateway instead of collapsing its owners into one.
type StoredEnrollment = { hash?: string; ownersHash?: string; enrolledAt?: number; owner?: string; owners?: string[] }

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
  return enrollment?.owners ?? [enrollment?.owner ?? fallback]
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
  const parsed = JSON.parse(text) as { gateways?: Record<string, StoredEnrollment | null> }
  const gateways: Record<string, Enrollment> = {}
  for (const [name, entry] of Object.entries(parsed.gateways ?? {})) {
    const enrollment = entry ? readEnrollment(entry) : undefined
    if (checkGatewayName(name) === null && enrollment) {
      gateways[name] = enrollment
    }
  }
  return { version: 1, gateways }
}

// A multi-owner record with an unreadable owner list is dropped whole: it never falls back to fewer owners.
function readEnrollment(entry: StoredEnrollment): Enrollment | undefined {
  const enrolledAt = typeof entry.enrolledAt === 'number' ? entry.enrolledAt : 0
  if (entry.ownersHash !== undefined || entry.owners !== undefined) {
    const owners = Array.isArray(entry.owners) ? entry.owners : []
    if (
      !isHash(entry.ownersHash) ||
      owners.length < 2 ||
      !owners.every((owner) => typeof owner === 'string' && checkOwnerName(owner) === null)
    ) {
      return undefined
    }
    return { hash: entry.ownersHash, enrolledAt, owners: [...new Set(owners)] }
  }
  if (!isHash(entry.hash)) {
    return undefined
  }
  return {
    hash: entry.hash,
    enrolledAt,
    ...(typeof entry.owner === 'string' && checkOwnerName(entry.owner) === null ? { owner: entry.owner } : {}),
  }
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function storedEnrollment(enrollment: Enrollment): StoredEnrollment {
  const { hash, enrolledAt, owner, owners } = enrollment
  if (owners && owners.length > 1) {
    return { ownersHash: hash, enrolledAt, owners }
  }
  const sole = owners?.[0] ?? owner
  return { hash, enrolledAt, ...(sole ? { owner: sole } : {}) }
}

function withOwners(hash: string, enrolledAt: number, owners: readonly string[] | undefined): Enrollment {
  if (!owners || owners.length === 0) {
    return { hash, enrolledAt }
  }
  return owners.length === 1 ? { hash, enrolledAt, owner: owners[0] } : { hash, enrolledAt, owners: [...owners] }
}

async function writeEnrollments(stateDir: string, file: EnrollmentFile): Promise<void> {
  const path = enrollmentPath(stateDir)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  const gateways = Object.fromEntries(Object.entries(file.gateways).map(([name, entry]) => [name, storedEnrollment(entry)]))
  await writeFile(tmp, `${JSON.stringify({ version: file.version, gateways }, null, 2)}\n`, { mode: 0o600 })
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
  const owners = requested ?? previous?.owners ?? (previous?.owner ? [previous.owner] : undefined)
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
