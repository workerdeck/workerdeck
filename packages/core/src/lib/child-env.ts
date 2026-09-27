// The gateway's own credentials. Model-provider credentials are deliberately absent: those are the SDK's to resolve.
export const GATEWAY_SECRET_ENV_KEYS: readonly string[] = ['WORKERDECK_AUTH_KEY', 'WORKERDECK_TOKEN']

export function withoutGatewaySecrets<T extends string | undefined>(env: Record<string, T>): Record<string, T> {
  const out = { ...env }
  for (const key of GATEWAY_SECRET_ENV_KEYS) {
    delete out[key]
  }
  return out
}
