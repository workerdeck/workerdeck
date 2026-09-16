import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import * as vscode from 'vscode'

export type HostSettings = {
  enabled: boolean
  autoStart: boolean
  port: number
  bindAddress: string
  requireAuthKey: boolean
  stateDir: string
  configPath: string | undefined
  binaryPath: string | undefined
  useNpx: boolean
  npxSpec: string | undefined
  dashboard: boolean
  shell: boolean
  cwdRoots: string[]
  statusBar: boolean
}

export const HOST_SECTION = 'workerdeck.host'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'])

export function expandHome(input: string): string {
  const text = input.trim()
  if (text === '') {
    return ''
  }
  if (text === '~') {
    return homedir()
  }
  if (text.startsWith('~/')) {
    return join(homedir(), text.slice(2))
  }
  return isAbsolute(text) ? text : resolve(text)
}

export function readHostSettings(): HostSettings {
  const config = vscode.workspace.getConfiguration(HOST_SECTION)
  const stateDir = expandHome(config.get<string>('stateDir', ''))
  const configPath = expandHome(config.get<string>('configPath', ''))
  const binaryPath = expandHome(config.get<string>('binaryPath', ''))
  return {
    enabled: config.get<boolean>('enabled', false),
    autoStart: config.get<boolean>('autoStart', true),
    port: config.get<number>('port', 8787),
    bindAddress: config.get<string>('bindAddress', '127.0.0.1').trim() || '127.0.0.1',
    requireAuthKey: config.get<boolean>('requireAuthKey', false),
    stateDir: stateDir || join(homedir(), '.workerdeck'),
    configPath: configPath || undefined,
    binaryPath: binaryPath || undefined,
    useNpx: config.get<boolean>('useNpx', true),
    npxSpec: config.get<string>('npxSpec', '').trim() || undefined,
    dashboard: config.get<boolean>('dashboard', true),
    shell: config.get<boolean>('shell', false),
    cwdRoots: config.get<string[]>('cwdRoots', []).map(expandHome).filter(Boolean),
    statusBar: config.get<boolean>('statusBar', true),
  }
}

export function settingsProblem(settings: HostSettings): string | undefined {
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    return `\`workerdeck.host.port\` is not a valid port: ${settings.port}`
  }
  return undefined
}

export function bindsPublicly(settings: HostSettings): boolean {
  return !LOOPBACK.has(settings.bindAddress)
}

// The bind address is what the server listens on; a wildcard bind is still reached at loopback from this machine.
export function managedUrl(settings: HostSettings): string {
  const address = settings.bindAddress === '0.0.0.0' || settings.bindAddress === '::' ? '127.0.0.1' : settings.bindAddress
  const literal = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
  return `http://${literal}:${settings.port}`
}
