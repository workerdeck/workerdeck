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
   * No `profiles` key on purpose: the server auto-detects a 'default' profile
   * from `~/.claude`, exactly like plain `npx workerdeck`, and sessions run
   * with whatever credentials the `claude` in your own terminal uses. That works
   * because the default dir is never pinned as `CLAUDE_CONFIG_DIR` — setting the
   * variable at all would move the CLI's credential source to
   * `<dir>/.credentials.json` and, on macOS, away from the login Keychain.
   *
   * A profile pointing anywhere else IS pinned, and needs its own credentials in
   * that directory (`CLAUDE_CONFIG_DIR=<dir> claude auth login`):
   *
   *   profiles: [{ name: 'work', configDir: '/Users/toby/work/.claude' }]
   *
   * Startup probes each profile with `claude auth status` and warns if one looks
   * logged out; `checkCredentials: false` turns that off.
   */

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
}
