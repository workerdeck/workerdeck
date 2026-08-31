// Run it with:  workerdeck --config ./workerdeck.config.mjs

/** @type {import('workerdeck').WorkerDeckConfig['authenticate']} */
const authenticate = (req) => {
  const key = req.headers['x-agent-proxy-key']
  if (typeof key !== 'string' || key !== process.env.AGENT_PROXY_KEY) {
    return null
  }
  return { id: 'gtm' }
}

/** @type {import('workerdeck').WorkerDeckConfig} */
export default {
  authenticate,

  allowedCwdRoots: ['/Users/atomic/services/gtm'],

  profiles: [
    { name: 'toby', configDir: '/Users/atomic/toby/.claude' },
    { name: 'dan', configDir: '/Users/atomic/dan/.claude' },
    { name: 'ruli', configDir: '/Users/atomic/ruli/.claude' },
    { name: 'mark', configDir: '/Users/atomic/mark/.claude' },
  ],

  requireApiKey: false,

  buildRunnerConfig: (req) => {
    const env = { ...process.env }
    delete env.AGENT_PROXY_KEY

    const token = { toby: 'CLAUDE_TOKEN_TOBY' }[req.profile ?? '']
    if (token && process.env[token]) {
      env.CLAUDE_CODE_OAUTH_TOKEN = process.env[token]
    }

    return { ...req, env }
  },
}
