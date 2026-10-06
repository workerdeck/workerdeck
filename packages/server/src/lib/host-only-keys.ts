import type { AiSdkRunnerConfig, CodexRunnerConfig, SessionRunnerConfig } from '@workerdeck/core'
import type { CreateSessionRequest } from '@workerdeck/protocol'

type HostOnlyKey = Exclude<keyof SessionRunnerConfig | keyof CodexRunnerConfig | keyof AiSdkRunnerConfig, keyof CreateSessionRequest>

// Every runner-config key that is not on the wire type. Typed as a record over that difference so a host-only field
// added to any engine's config without an entry here fails typecheck, as does an entry since promoted onto
// CreateSessionRequest. `durable` keys survive into a stored session record; `transient` ones are rederived on rebuild.
const HOST_ONLY_KEY_TABLE: Record<HostOnlyKey, 'durable' | 'transient'> = {
  epoch: 'durable',
  pricing: 'transient',
  queryFn: 'transient',
  env: 'transient',
  pathToClaudeCodeExecutable: 'durable',
  extraOptions: 'transient',
  instructions: 'transient',
  defaultApprovalTimeoutMs: 'durable',
  backfillHistory: 'durable',
  historyFn: 'transient',
  sessionInfoFn: 'transient',
  peers: 'transient',
  contextReset: 'transient',
  shells: 'transient',
  shellAgentWrite: 'transient',
  createdByOperator: 'durable',
  fallbackTitle: 'transient',
  startAsleep: 'transient',
  effortDefaults: 'transient',
  statusLabel: 'durable',
  connectFn: 'transient',
  codexHome: 'durable',
  codexPathOverride: 'durable',
  languageModel: 'transient',
  tools: 'transient',
  maxSteps: 'durable',
  executor: 'transient',
  executableTools: 'transient',
  vfs: 'transient',
  executionLimits: 'durable',
  executionBackend: 'transient',
  toolTitles: 'transient',
  shouldApprove: 'transient',
  resolveModel: 'transient',
  contextWindow: 'transient',
  reportMcpServers: 'transient',
  onClose: 'transient',
  restore: 'transient',
}

export const HOST_ONLY_KEYS: ReadonlySet<string> = new Set(Object.keys(HOST_ONLY_KEY_TABLE))

export const DURABLE_HOST_KEYS: readonly string[] = Object.entries(HOST_ONLY_KEY_TABLE)
  .filter(([, lifetime]) => lifetime === 'durable')
  .map(([key]) => key)
