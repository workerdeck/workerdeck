/**
 * Library surface of the turnkey instance, for hosts that want the same wiring
 * (single-port gateway + dashboard + shared-secret auth) inside their own
 * process rather than as a child. The `bin` is a thin shell over exactly this.
 */
export { startInstance, resolveWebRoot, createHostGuard } from './instance.ts'
export type { Instance } from './instance.ts'
export {
  ConfigError,
  defaultStateDir,
  hostnameOf,
  isLoopback,
  isLoopbackHostname,
  loadConfigFile,
  parseArgs,
  resolveInstanceConfig,
} from './config.ts'
export type {
  WorkerDeckConfig,
  CliFlags,
  LoadedConfig,
  ResolvedConfig,
} from './config.ts'
export { runGuard } from './guard.ts'
export { materializeAuthKey } from './auth-key.ts'
export type { MaterializedAuthKey } from './auth-key.ts'
export { createCliAuth } from './auth.ts'
export type { CliAuth, CliAuthOptions, CliPrincipal, CliSessionStore, StoredSession } from './auth.ts'
export { createAuthSessionStore } from './auth-sessions.ts'
export type { AuthSessionStoreOptions } from './auth-sessions.ts'
export { renderLoginPage } from './login-page.ts'
export type { LoginPageOptions } from './login-page.ts'
export { createApnsClient, loadApnsKey } from './apns/client.ts'
export type { ApnsClient, ApnsConfig, ApnsEnvironment, ApnsRequest, ApnsResult } from './apns/client.ts'
export { createDeviceRegistry, createDeviceRoute } from './apns/devices.ts'
export type { DeviceRecord, DeviceRegistry } from './apns/devices.ts'
export { buildPush, createApnsForwarder } from './apns/forwarder.ts'
export type { ApnsForwarder } from './apns/forwarder.ts'
