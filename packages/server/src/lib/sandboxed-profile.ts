import type { ProfileInfo, ProviderConfig, SessionCapability } from '@workerdeck/protocol'

/**
 * A `provider` profile that grants a session nothing but the sandbox: the
 * QuickJS guest, the in-memory VFS, and the model.
 *
 * This adds no mechanism. `capabilities: []` and `mcpServers: []` already mean
 * what they mean, and `createToolContext` already withholds a tool whose backend
 * the host did not inject. What the helper buys is that the locked-down profile
 * is one call rather than three fields an operator has to get right together —
 * the failure mode being a profile that *looks* sandboxed and still grants
 * `deliver_file` because nobody wrote the empty array.
 *
 * What a session under it can do:
 * - run untrusted JavaScript in the WASM guest, under the interpreter's own
 *   timeout and memory limits (`eval_script`),
 * - read and write the session's in-memory VFS, which is a map and not a
 *   filesystem — no host path is reachable from it.
 *
 * What it cannot do: read or write a host path, spawn a process, reach the
 * network (`web_fetch`/`download`/`web_search` are capabilities, and none is
 * granted), deliver a file, or use an MCP server.
 *
 * Two things this helper does **not** do, because they are not a profile's to
 * decide. It does not authorize anyone — visibility is
 * `CreateSessionRequest.scope` plus the gateway's `authorizeSession`. And it
 * does not make the model's *input* trustworthy: content the loop reads is
 * attacker-influenced by default, and a sandbox bounds what a tool can reach,
 * not what a prompt can talk the model into asking for.
 *
 * @param name Profile name clients name in `CreateSessionRequest.profile`.
 * @param provider Which model to run (credentials stay in the operator's
 *   environment and are resolved by the host's `createEngineRunner` — never
 *   here, and never on the wire).
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
