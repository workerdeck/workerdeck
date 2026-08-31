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
    maxJobDurationMs: 15 * 60 * 1000,
    retention: { maxAgeMs: 60 * 60 * 1000 },
  },

  allowedCwdRoots: ['/Users/atomic/projects'],

  hostFiles: {
    write: true,
    roots: ['/Users/atomic/projects'],
    maxFileBytes: 8 * 1024 * 1024,
  },

  stateDir: '/tmp/workerdeck-prod',
}
