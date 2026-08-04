/**
 * Advanced `workerdeck` configuration — the shape a real deployment needs.
 *
 * `npx workerdeck` needs none of this: with no config file it serves the
 * gateway and the dashboard on 127.0.0.1:8787, unauthenticated, with durable
 * parking under ~/.workerdeck. This file is for the cases flags cannot
 * express, because the options are functions.
 *
 * Run it with:  workerdeck --config ./workerdeck.config.mjs
 *
 * Precedence is narrowest-wins: flags > env > this file > defaults.
 */

/**
 * Supplying `authenticate` turns the built-in shared-secret auth off entirely —
 * one hook, one scheme, no chance of a second path nobody audited. The cost is
 * that the dashboard can no longer log itself in: a browser cannot put a header
 * on a WebSocket handshake, so if you take this over you are responsible for a
 * credential the browser can actually present (a cookie your own middleware
 * sets, typically). Use `--auth-key` instead unless you need this.
 */
/** @type {import('workerdeck').WorkerDeckConfig['authenticate']} */
const authenticate = (req) => {
  const key = req.headers['x-agent-proxy-key']
  if (typeof key !== 'string' || key !== process.env.AGENT_PROXY_KEY) return null
  // Any truthy value is a principal. `allowedProfiles` narrows which profiles
  // this caller may start sessions under; omit it to allow all of them.
  return { id: 'gtm' }
}

/** @type {import('workerdeck').WorkerDeckConfig} */
export default {
  authenticate,

  // Sessions may only run inside these roots. Strongly recommended: without it
  // a caller picks any directory on the box.
  allowedCwdRoots: ['/Users/atomic/services/gtm'],

  /**
   * One config dir per identity. The directory *is* the credential store — the
   * SDK resolves auth from it — so four profiles here is four billing
   * identities, and an ANTHROPIC_API_KEY in the server env would win for all of
   * them and collapse the four into one. Don't set one.
   */
  profiles: [
    { name: 'toby', configDir: '/Users/atomic/toby/.claude' },
    { name: 'dan', configDir: '/Users/atomic/dan/.claude' },
    { name: 'ruli', configDir: '/Users/atomic/ruli/.claude' },
    { name: 'mark', configDir: '/Users/atomic/mark/.claude' },
  ],

  // Personal/single-operator deployments may legitimately run on a subscription;
  // services and unattended use want `true` (Anthropic's terms require API-key
  // auth for those). The server logs a one-time notice either way.
  requireApiKey: false,

  /**
   * Per-session config, including the env each session runs with. Note what is
   * NOT durable here: a session rebuilt from a parked record is assembled from
   * the stored config, and a durable store persists neither `env` nor injected
   * functions. Anything a woken session still needs has to be resolvable again,
   * not carried in `env`.
   */
  buildRunnerConfig: (req) => {
    const env = { ...process.env }
    // The gateway's own key has no business inside a session's environment.
    delete env.AGENT_PROXY_KEY

    // A long-lived token per profile, injected rather than resolved from the
    // profile's config dir. Under launchd, config-dir credential resolution
    // fails with "OAuth session expired and could not be refreshed" even with
    // fresh credentials in place; this sidesteps that path entirely.
    const token = { toby: 'CLAUDE_TOKEN_TOBY' }[req.profile ?? '']
    if (token && process.env[token]) env.CLAUDE_CODE_OAUTH_TOKEN = process.env[token]

    return { ...req, env }
  },
}
