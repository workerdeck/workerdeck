/** @type {import('workerdeck').WorkerDeckConfig} */
export default {
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

  queue: {
    maxConcurrency: 2,
    maxJobDurationMs: 30 * 60 * 1000,
    retention: { maxAgeMs: 24 * 60 * 60 * 1000 },
  },

  allowedCwdRoots: ['/Users/atomic/projects'],

  hostFiles: {
    write: true,
    // Declaring `roots` REPLACES the `allowedCwdRoots` inheritance: every tree this gateway serves must be listed here.
    roots: ['/Users/atomic/projects'],
    maxFileBytes: 8 * 1024 * 1024,
  },

  // `!` shell mode in the composer. Off by default everywhere; on here because this is the
  // dev gateway on a tailnet, run by the operator whose machine it is. It goes through no
  // permission flow at all — see docs/GOTCHAS.md § Shell mode before copying this into anything
  // that faces someone else.
  shell: { enabled: true },

  apns: {
    keyFile: './.workerdeck/AuthKey_DD89249M52.p8',
    keyId: 'DD89249M52',
    teamId: 'TT5SR2JM9L',
    topic: 'bi.atomic.workerdeck.ios',
  },
}
