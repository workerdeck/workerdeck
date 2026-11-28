import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ServiceVerb = 'start' | 'stop' | 'restart' | 'uninstall'

const TARGET_FLAGS = new Set(['--port', '-p', '--state-dir'])

export function servicePlistPath(port: number, home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `dev.workerdeck.gateway.${port}.plist`)
}

export function serviceLogPath(stateDir: string): string {
  return join(stateDir, 'logs', 'gateway.log')
}

export function serviceOwned(port: number, platform: NodeJS.Platform = process.platform, home: string = homedir()): boolean {
  return platform === 'darwin' && existsSync(servicePlistPath(port, home))
}

// `runCli` appends `--port` and `--state-dir` itself; a second copy would be an unknown option to `service`.
// `--force`: Host Mode's own busy-sessions confirmation has already run, and it replaces the CLI's guard.
export function serviceCommand(verb: ServiceVerb): string[] {
  return verb === 'start' ? ['service', 'start'] : ['service', verb, '--force']
}

// After `--`, so the `--port` and `--state-dir` that `runCli` appends land in the gateway flags, where install reads them.
export function serviceInstallCommand(gatewayArgv: readonly string[]): string[] {
  return ['service', 'install', '--', ...withoutTarget(gatewayArgv)]
}

function withoutTarget(argv: readonly string[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (TARGET_FLAGS.has(argv[i]!)) {
      i++
      continue
    }
    kept.push(argv[i]!)
  }
  return kept
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index < 0 ? undefined : argv[index + 1]
}

export function plistProgramArguments(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? ''
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((match) =>
    match[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
  )
}

// The agent's argv is fixed at install, so a restart picks up changed settings only through a reinstall.
export function serviceArgvCurrent(plist: string, gatewayArgv: readonly string[]): boolean {
  const port = valueOf(gatewayArgv, '--port')
  const stateDir = valueOf(gatewayArgv, '--state-dir')
  if (port === undefined || stateDir === undefined) {
    return false
  }
  const expected = [...withoutTarget(gatewayArgv), '--port', port, '--state-dir', stateDir]
  // `gatewayArgv` always leads with `--host`, so it marks where the node binary and the CLI script end.
  const actual = plistProgramArguments(plist)
  const start = actual.indexOf(expected[0]!)
  return start > 0 && actual.length - start === expected.length && expected.every((arg, i) => actual[start + i] === arg)
}
