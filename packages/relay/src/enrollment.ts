import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RELAY_GATEWAY_NAME } from '@workerdeck/relay-client'

export type Enrollment = { hash: string; enrolledAt: number }

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
      gateways[name] = { hash: entry.hash, enrolledAt: typeof entry.enrolledAt === 'number' ? entry.enrolledAt : 0 }
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

export async function enrollGateway(stateDir: string, name: string, options?: { rotate?: boolean }): Promise<string> {
  const invalid = checkGatewayName(name)
  if (invalid) {
    throw new Error(invalid)
  }
  const file = await readEnrollments(stateDir)
  if (file.gateways[name] && !options?.rotate) {
    throw new Error(`gateway ${name} is already enrolled; pass --rotate to issue a new key`)
  }
  const key = newGatewayKey()
  file.gateways[name] = { hash: hashKey(key), enrolledAt: Date.now() }
  await writeEnrollments(stateDir, file)
  return key
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
