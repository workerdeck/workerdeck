/**
 * The *production* build, run locally — for manual testing before a release. Edit it directly.
 *
 *   pnpm start:prod    # builds if needed, then serves http://127.0.0.1:8788
 * It differs from `examples/dev-server.config.mjs` not in what it configures but in what *code
 * runs*: the built `packages/cli/build/cli.mjs` with no `@workerdeck/source` condition, so every
 * import resolves to `build/` and the dashboard is production React — the only honest surface to
 * judge perf or a release candidate on (`docs/DEVELOPMENT.md`). Port 8788 so it runs alongside
 * `dev:server`, state in `/tmp` so a throwaway session never lands in the real store, and no
 * `apns` key — the push credential belongs to the instance you actually run.
 * @type {import('workerdeck').WorkerDeckConfig}
 */
export default {
  /**
   * The same two profiles the dev gateway declares — a claude profile from your
   * own `~/.claude`, and codex over its own `~/.codex` login. Auth is the
   * binaries' own in both cases; WorkerDeck holds no credential here.
   *
   * The claude default dir is never pinned as `CLAUDE_CONFIG_DIR`: setting the
   * variable at all moves the CLI's credential source off the macOS Keychain.
   */
  profiles: [
    {
      name: 'claude',
      configDir: `${process.env.HOME}/.claude`,
      description: 'Claude Code via the Agent SDK (your own config dir)',
    },
    {
      name: 'codex',
      engine: 'codex',
      description: 'OpenAI Codex via the codex CLI (your own ~/.codex)',
    },
  ],

  /**
   * A throwaway instance still wants the queue on, because the Jobs section is
   * part of what there is to test. The bounds are lower than dev's on purpose:
   * nothing here is meant to outlive the session you are testing in.
   */
  queue: {
    maxConcurrency: 2,
    maxJobDurationMs: 15 * 60 * 1000,
    retention: { maxAgeMs: 60 * 60 * 1000 },
  },

  /**
   * Where sessions may run, and with that what `/v1/fs/*` serves. Same trust
   * boundary as dev: point it at a projects directory, never `~`.
   */
  allowedCwdRoots: ['/Users/atomic/projects'],

  /**
   * Writing is its own switch because an agent's edits go through the permission
   * flow and a `PUT /v1/fs/write` does not. On here because the workspace's
   * editor is part of what a pre-release pass is checking.
   */
  hostFiles: {
    write: true,
    roots: ['/Users/atomic/projects'],
    maxFileBytes: 8 * 1024 * 1024,
  },

  /**
   * Parked sessions, and the auth key if one is ever generated, in a directory
   * that is expected to disappear. The default would be `examples/.workerdeck/`
   * — the dev gateway's own store — and sharing it would defeat the point.
   */
  stateDir: '/tmp/workerdeck-prod',
}
