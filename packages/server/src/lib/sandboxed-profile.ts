import type { ProfileInfo, ProviderConfig, SessionCapability } from '@workerdeck/protocol'

export const sandboxedProviderProfile = (
  name: string,
  provider: ProviderConfig,
  options: {
    description?: string
    instructions?: string
    defaults?: ProfileInfo['defaults']
    capabilities?: SessionCapability[]
    mcpServers?: string[]
  } = {},
): ProfileInfo => {
  return {
    name,
    engine: 'provider',
    provider,
    description: options.description ?? 'Sandboxed: no host filesystem, no shell, no egress',
    defaults: options.defaults,
    session: {
      capabilities: options.capabilities ?? [],
      mcpServers: options.mcpServers ?? [],
      instructions: options.instructions,
    },
  }
}
