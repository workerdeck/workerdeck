// Provider resolution for the live smokes. Three scripts carried this block verbatim, so
// adding a fourth provider meant three identical edits.
export type ProviderName = 'moonshot' | 'openai' | 'anthropic'

const PROVIDERS: Record<ProviderName, { env: string; defaultModel: string; load: () => Promise<unknown> }> = {
  moonshot: {
    env: 'MOONSHOT_API_KEY',
    defaultModel: 'kimi-k3',
    load: () => import('@ai-sdk/moonshotai').then((m) => m.moonshotai),
  },
  openai: {
    env: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    load: () => import('@ai-sdk/openai').then((m) => m.openai),
  },
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-5',
    load: () => import('@ai-sdk/anthropic').then((m) => m.anthropic),
  },
}

/**
 * Resolve `[provider] [model-id]` from a smoke's argv tail, then load the provider factory.
 * Exits with the usage message rather than returning: a live smoke with no key has nothing to
 * do, and `script` names the pnpm script so the hint stays correct per caller.
 */
export async function resolveProvider(
  args: string[],
  script: string,
): Promise<{ providerName: ProviderName; modelId: string; apiKeyEnv: string; factory: (id: string) => never }> {
  const providerName = (args[0] ?? 'moonshot') as ProviderName
  const provider = PROVIDERS[providerName]
  if (!provider) {
    console.error(`Unknown provider '${providerName}'. Use one of: ${Object.keys(PROVIDERS).join(', ')}`)
    process.exit(1)
  }
  if (!process.env[provider.env]) {
    console.error(`\nMissing ${provider.env} in the environment.\n`)
    console.error(`  ${provider.env}=... pnpm ${script} ${providerName}\n`)
    process.exit(1)
  }
  const modelId = args[1] ?? provider.defaultModel
  const factory = (await provider.load()) as (id: string) => never
  return { providerName, modelId, apiKeyEnv: provider.env, factory }
}

/** Quote a block of provider output so it reads as transcript rather than as log lines. */
export function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => '   │ ' + line)
    .join('\n')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
