/**
 * The dev gateway, as a `workerdeck` config file — a starting point to edit, not a knob panel. It
 * runs the same binary `npx workerdeck` gives a user, so dev and ship are one code path; parked
 * sessions land in the gitignored `examples/.workerdeck/`.
 *   pnpm dev:server    # gateway + dashboard on http://127.0.0.1:8787
 *   pnpm dev:web       # optional: vite dashboard on :5191 with HMR, proxying /v1 here
 * To reach it from another device (the iOS app over Tailscale), export `WD_DEV_HOST` in your own
 * shell — never in the committed script, it names one machine. The script binds it, declares it an
 * accepted Host header, and `--insecure-host` waives the key: a tailnet only. Elsewhere pass
 * `--auth-key`, or let the CLI generate one into the state dir.
 * @type {import('workerdeck').WorkerDeckConfig}
 */
export default {
  /**
   * A claude profile from your own `~/.claude` (exactly what auto-detection would create) plus a
   * codex profile — engine adapters ship in the box, and auth is each binary's own: run
   * `codex login` in YOUR terminal and the profile goes green. The claude default dir is never
   * pinned as `CLAUDE_CONFIG_DIR`, because setting the variable at all moves the CLI's credential
   * source off the macOS login Keychain; a profile pointing anywhere else IS pinned and needs its
   * own credentials there (`docs/GOTCHAS.md` §Server, profiles & auth). `codexHome` is the codex
   * analogue and has no Keychain trap. Startup probes every profile's credentials;
   * `checkCredentials: false` turns that off.
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
    // Declaring `roots` REPLACES the `allowedCwdRoots` inheritance, so every
    // tree this gateway may serve has to be listed here.
    //
    // Note what is NOT here any more: codex's `$CODEX_HOME/generated_images`
    // drawer. Generated images no longer come through `/fs/*` at all — the
    // runner announces the path it wrote in a `file_produced` event and the
    // gateway serves it from `/sessions/:id/produced/:fileId`, whose allowlist
    // is that announcement rather than a directory grant. Which is the point:
    // seeing a picture your own agent just made should not require widening a
    // filesystem grant toward `~/.codex`, where `auth.json` also lives.
    roots: ['/Users/atomic/projects'],
    // Kept for ordinary reads: the 1 MiB default is small for a screenshot or a
    // PDF the agent left in the project.
    maxFileBytes: 8 * 1024 * 1024,
  },

  /**
   * Push notifications for the iOS app, and the only place in the project holding a push
   * credential. Delete this key entirely to turn the forwarder off — `/apns/devices` then 404s,
   * which is how the app learns a gateway does not push. `keyFile` is a path and never key
   * contents, resolved relative to this file; gitignore is not the plan for the p8 itself, which
   * belongs in the password manager (it downloads exactly once and a team gets two). The
   * environment is deliberately not set here — it is a property of each device token.
   * See `docs/GOTCHAS.md` §APNs push.
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
