import { PROTOCOL_VERSION } from '@workerdeck/protocol'

// The operator's environment reaches the child whole - WorkerDeck resolves no credential of its
// own - and the profile's CODEX_HOME is the one key it pins, last, so a profile always wins over
// an inherited value. Every path that spawns or connects to an app-server goes through here.
export function codexChildEnv(base: Record<string, string | undefined>, codexHome?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (codexHome) {
    env.CODEX_HOME = codexHome
  }
  return env
}

// `request_user_input` - the tool behind `item/tool/requestUserInput`, which WorkerDeck already
// answers as an `AskUserQuestion` permission request - is off by default and behind TWO gates,
// and one without the other reads as the tool not existing: the first registers it at all, the
// second lets the router run it outside Plan mode (without it a Default-mode call is refused with
// "request_user_input is unavailable in Default mode" and the model reports the tool as
// unavailable). Neither has a per-thread switch on the app-server, so they are spawn arguments.
// An unrecognised `-c` key is ignored unless `--strict-config` is passed, so an older codex that
// knows neither gate still starts. `questionBehavior` decides what an unattended session answers.
export const APP_SERVER_ARGS = [
  'app-server',
  '-c',
  'tools.experimental_request_user_input.enabled=true',
  '-c',
  'features.default_mode_request_user_input=true',
] as const

// `experimentalApi` gates the granular approval policy and there is no non-experimental fallback, so it is not per-call-site.
export const INITIALIZE_PARAMS = {
  clientInfo: {
    name: 'workerdeck',
    title: 'WorkerDeck',
    version: `protocol-${PROTOCOL_VERSION}`,
  },
  capabilities: { experimentalApi: true },
} as const
