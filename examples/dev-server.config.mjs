/**
 * The dev gateway, as a `workerdeck` config file. Edit it directly — it is a
 * starting point to change, not a knob panel to configure.
 *
 *   pnpm server    # gateway + dashboard on http://127.0.0.1:8787
 *   pnpm web       # optional: vite dashboard on :5191 with HMR, proxying /v1 here
 *
 * There is no separate dev entry point any more: this runs the same `workerdeck`
 * binary a user gets from `npx workerdeck`, so the thing you develop against and
 * the thing you ship are one code path — including the single-origin model, where
 * the dashboard is served from the gateway's own port rather than a vite proxy.
 *
 * Parked sessions land in `examples/.workerdeck/` (gitignored) and survive a
 * restart; `--no-parking-store` opts out.
 *
 * ## Reaching it from another device (the iOS app, over Tailscale)
 *
 * `--host` picks the interface to bind; the default is loopback only.
 *
 *   pnpm server --host 0.0.0.0
 *
 * Auth off loopback is not optional theatre: anyone who can reach the port would
 * get a Claude Code session. Pass `--auth-key <secret>`, or let the CLI generate
 * one — printed once, kept in the state dir (`examples/.workerdeck/auth-key`
 * here), reused on later starts. Native clients (the iOS app) send it as
 * `Authorization: Bearer <key>`; browsers post it once at the login page and ride a
 * cookie. Then point the client at `http://<your-tailscale-name>:8787`.
 *
 * If you really want no auth on a trusted tailnet, declare the bind host — one
 * declaration waives the key for that host and doubles as an accepted Host header
 * (an unauthenticated instance otherwise only answers to loopback names):
 *
 *   pnpm server --host toby --insecure-host toby
 */
/** @type {import('workerdeck').WorkerDeckConfig} */
export default {
  /**
   * A claude profile from your own `~/.claude` (exactly what auto-detection
   * would create), plus a codex profile — engine adapters ship in the box, so
   * declaring one is all it takes. Codex auth is the binary's own: run
   * `codex login` (or `codex login --with-api-key`) in YOUR terminal and the
   * profile goes green; until then it lists as unavailable with the remedy,
   * and creating a session against it simply fails with codex's own error.
   *
   * The claude default dir is never pinned as `CLAUDE_CONFIG_DIR` — setting the
   * variable at all would move the CLI's credential source to
   * `<dir>/.credentials.json` and, on macOS, away from the login Keychain. A
   * profile pointing anywhere else IS pinned, and needs its own credentials in
   * that directory (`CLAUDE_CONFIG_DIR=<dir> claude auth login`). The codex
   * analogue is `codexHome` (unset = the binary's own `~/.codex`), which has no
   * Keychain trap.
   *
   * Startup probes every profile's credentials and warns if one looks logged
   * out; `checkCredentials: false` turns that off.
   */
  profiles: [
    {
      name: 'claude',
      configDir: `${process.env.HOME}/.claude`,
      description: 'Claude Code via the Agent SDK (your own config dir)',
    },
    /**
     * Codex runs over the binary's `app-server` JSON-RPC surface: one child
     * per session, held across turns, streaming token-by-token. Same auth
     * story as claude — the binary's own `~/.codex` login, never anything
     * WorkerDeck holds.
     */
    {
      name: 'codex',
      engine: 'codex',
      description: 'OpenAI Codex via the codex CLI (your own ~/.codex)',
    },
  ],

  /**
   * The queue is on in dev so `/jobs` and the dashboard's Jobs view are live. The
   * watchdog and retention bounds are the point of these defaults: a long-lived dev
   * server otherwise wedges on a stuck CLI, or grows without limit.
   */
  queue: {
    maxConcurrency: 2,
    maxJobDurationMs: 30 * 60 * 1000,
    retention: { maxAgeMs: 24 * 60 * 60 * 1000 },
  },

  /**
   * Where sessions may run — and, with that, what the host-file routes
   * (`/v1/fs/*`) will serve. The iOS app's Files browser and its `@file`
   * completion read through those routes.
   *
   * One policy, not two: a caller holding the auth key can already start a
   * session in any of these directories and have the agent read whatever is in
   * them, so `/fs` reading the same trees adds no authority. Point this at a
   * projects directory rather than `~` — it is the whole trust boundary, and
   * symlinks pointing out of it are refused, not followed.
   */
  allowedCwdRoots: ['/Users/atomic/projects'],

  /**
   * Writing is the part that is NOT already implied: an agent's edits go through
   * the permission flow, and a `PUT /v1/fs/write` does not. Hence its own switch.
   * Delete this key for a read-only file surface; `roots: []` turns `/fs` off
   * entirely. Writes are still conditional on the hash the client read, so a file
   * the agent changed first is a 409, not a silent clobber.
   */
  hostFiles: {
    write: true,
  },

  /**
   * Push notifications for the iOS app. Delete this key entirely to turn the
   * forwarder off — with it absent, `/apns/devices` 404s, which is how the app
   * learns a gateway does not push.
   *
   * This is the only place in the project that holds a push credential;
   * `packages/server` emits the notifications and knows nothing about Apple.
   * `keyFile` is a path and never key contents, resolved relative to this file.
   * It points into `.workerdeck/`, which is gitignored as a whole — and `*.p8`
   * is ignored too, but neither is the actual plan: the p8 belongs in the
   * password manager, because it downloads exactly once, Apple deletes their
   * copy on download, and a team only gets two of them.
   *
   * The environment is deliberately *not* set here. It is a property of each
   * device token: the app registers as `development` (built from Xcode) or
   * `production` (TestFlight), and the forwarder routes each token to the
   * endpoint it belongs to. They are different namespaces, not just different
   * URLs — cross them and Apple answers `BadDeviceToken`.
   */
  apns: {
    keyFile: './.workerdeck/AuthKey_DD89249M52.p8',
    keyId: 'DD89249M52',
    teamId: 'TT5SR2JM9L',
    // The APNs topic is the app's bundle id, and must match
    // `PRODUCT_BUNDLE_IDENTIFIER` in apps/ios/project.yml.
    topic: 'bi.atomic.workerdeck.ios',
  },
}
