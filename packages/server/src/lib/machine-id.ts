import { createHash } from 'node:crypto'
import { arch, homedir, hostname, platform } from 'node:os'

let cached: string | undefined

// An opaque fingerprint of the machine this process runs on. A client that computes the same
// string for itself is on the same box as the gateway, which is what lets it open the gateway's
// paths natively instead of proxying them over `/fs`. Hashed so the answer carries no hostname
// or home directory, and cached because none of its inputs move within a process.
//
// `apps/vscode/src/machine.ts` recomputes this byte for byte. The two must be changed together:
// a drift only shows up as "local files stopped opening natively", never as a failure.
export function machineId(): string {
  cached ??= createHash('sha256').update([hostname(), platform(), arch(), homedir()].join('\0')).digest('hex').slice(0, 32)
  return cached
}
