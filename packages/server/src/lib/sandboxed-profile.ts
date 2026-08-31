import type { ProfileInfo, ProviderConfig, SessionCapability } from '@workerdeck/protocol'

/**
 * A `provider` profile that grants a session nothing but the sandbox: the QuickJS guest, the
 * in-memory VFS, and the model. No host path, no process, no network, no MCP.
 *
 * It adds no mechanism — the **empty arrays** are the whole thing, and writing them together in
 * one call is the point: a profile that omits one *looks* sandboxed and still grants what the
 * host wired. It authorizes nobody (that is `scope` + `authorizeSession`) and does not make the
 * model's input trustworthy. See `docs/PACKAGES.md` §`packages/server`.
 *
 * @param provider Credentials stay in the operator's environment and are resolved by
 *   `createEngineRunner` — never here, and never on the wire.
 */
export const sandboxedProviderProfile = (
  name: string,
  provider: ProviderConfig,
  options: {
    description?: string
    /** Prepended to the session's system prompt. */
    instructions?: string
    /** Profile-level run defaults (model, permission mode) — see
     * {@link ProfileInfo.defaults}. */
    defaults?: ProfileInfo['defaults']
    /**
     * Capabilities to grant on top of the floor. Default `[]` — the floor is
     * nothing, and every entry here is a deliberate widening you are writing
     * down: `web_fetch` gives the loop egress (SSRF-guarded, but egress),
     * `download` and `web_search` reach whatever backends you injected, and
     * `deliver_file` lets it hand a file to the client.
     */
    capabilities?: SessionCapability[]
    /**
     * MCP servers, **by name**, whose tools sessions may use. Default `[]`.
     * MCP tools are authoritative — they run with the host's credentials and
     * are never bridged — so naming one here is a larger grant than any
     * capability above it.
     */
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
      // Both arrays are load-bearing and neither may become `undefined`: absent
      // means "no declaration", which grants whatever the host happened to wire
      // — the opposite of what this profile promises. An explicit `[]` is the
      // floor; the options above raise it in the open.
      capabilities: options.capabilities ?? [],
      mcpServers: options.mcpServers ?? [],
      instructions: options.instructions,
    },
  }
}
