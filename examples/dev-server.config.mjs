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

  apns: {
    keyFile: './.workerdeck/AuthKey_DD89249M52.p8',
    keyId: 'DD89249M52',
    teamId: 'TT5SR2JM9L',
    topic: 'bi.atomic.workerdeck.ios',
  },
}
