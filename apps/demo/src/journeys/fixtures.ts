import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type {
  ModelOption,
  ProfileInfo,
  ProjectInfo,
  RateLimitInfo,
  SessionEventBody,
  SessionInfo,
  SubagentInfo,
} from '@workerdeck/protocol'

import type { SessionSeed } from '../stage/gateway.ts'
import { beat, context, event, rateLimit, say, status, tool, turnEnd, user, type Beat } from '../stage/tape.ts'

export const CWD = '/Users/you/projects/acme-web'

export const PROJECT: ProjectInfo = { name: 'acme-web', root: CWD, icon: { type: 'glyph', name: 'layers' } } as ProjectInfo

export const OPUS = 'claude-opus-5-20260101'
export const SONNET = 'claude-sonnet-5-20260101'
export const CODEX = 'gpt-5.6-sol'

const MINUTE = 60_000

const CLAUDE_MODELS: ModelOption[] = [
  {
    value: OPUS,
    displayName: 'Opus 5',
    description: 'Opus 5 · Best for complex tasks',
    primary: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
  {
    value: SONNET,
    displayName: 'Sonnet 5',
    description: 'Sonnet 5 · Efficient for routine tasks',
    primary: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
]

const CODEX_MODELS: ModelOption[] = [
  {
    value: CODEX,
    displayName: 'GPT-5.6 Sol',
    description: 'Frontier agentic coding model',
    primary: true,
    reasoningEfforts: ['low', 'medium', 'high'],
  },
]

export const PROFILES: ProfileInfo[] = [
  {
    name: 'claude',
    engine: 'claude',
    models: CLAUDE_MODELS,
    defaultModel: OPUS,
    capabilities: ENGINE_CAPABILITIES.claude,
    available: true,
  },
  { name: 'codex', engine: 'codex', models: CODEX_MODELS, defaultModel: CODEX, capabilities: ENGINE_CAPABILITIES.codex, available: true },
]

const NOW_S = Math.round(Date.now() / 1000)

const LIMITS: RateLimitInfo[] = [
  { status: 'allowed', rateLimitType: 'five_hour', utilization: 31, resetsAt: NOW_S + 2.4 * 3600 },
  { status: 'allowed', rateLimitType: 'seven_day', utilization: 58, resetsAt: NOW_S + 3 * 24 * 3600 },
] as RateLimitInfo[]

export function boot(engine: 'claude' | 'codex', model: string): Beat {
  const init: SessionEventBody = {
    type: 'system_init',
    sdkSessionId: `sdk-${Math.random().toString(36).slice(2, 10)}`,
    model,
    cwd: CWD,
    apiKeySource: engine === 'claude' ? 'ANTHROPIC_API_KEY' : 'codex login',
    tools: ['Task', 'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'TodoWrite', 'WebFetch'],
    skills: [],
    slashCommands: ['compact', 'clear', 'context', 'review'],
    permissionMode: 'default',
    claudeCodeVersion: '2.1.60',
    mcpServers: [{ name: 'workerdeck', status: 'connected' }],
  }
  return beat(
    event(init),
    event({ type: 'capabilities', models: engine === 'claude' ? CLAUDE_MODELS : CODEX_MODELS, commands: [], defaultModel: model }),
    ...(engine === 'claude' ? LIMITS.map(rateLimit) : []),
  )
}

export function seed(info: Partial<SessionInfo> & { id: string }, history: Beat, startedAgo: number): SessionSeed {
  return { info: { cwd: CWD, project: PROJECT, ...info }, history, startedAgo }
}

export function agent(toolUseId: string, description: string, state: SubagentInfo['status'], toolCount = 0): SubagentInfo {
  return { toolUseId, agentType: 'general-purpose', description, status: state, startedAt: Date.now() - 2 * MINUTE, toolCount }
}

export function landingSeed(): SessionSeed {
  return seed(
    { id: 'landing', title: 'Spring launch landing page', engine: 'claude', model: OPUS },
    beat(
      boot('claude', OPUS),
      user('Set up a new marketing site.'),
      status('running'),
      2000,
      say('Done: a fresh site in `apps/site`, ready for content.'),
      context(18),
      turnEnd({ durationMs: 64_000, totalCostUsd: 0.41 }),
    ),
    38 * MINUTE,
  )
}

export function checkoutSeed(): SessionSeed {
  return seed(
    { id: 'checkout', title: 'Fix the flaky checkout test', engine: 'codex', model: CODEX },
    beat(
      boot('codex', CODEX),
      user('The checkout test fails about one run in five. Find out why and fix it.'),
      status('running'),
      1500,
      say('The cart total is computed before prices finish loading. Fixing the order.'),
    ),
    12 * MINUTE,
  )
}

export function reviewSeed(): SessionSeed {
  return seed(
    { id: 'review', title: 'Review PR #412', engine: 'claude', model: SONNET },
    beat(
      boot('claude', SONNET),
      user('Review PR #412 and run the tests.'),
      status('running'),
      1200,
      say('The change looks good. Running the tests before I sign off.'),
      tool('toolu_suite', 'Bash', { command: 'pnpm test', description: 'Run the tests' }),
      event({
        type: 'permission_requested',
        request: {
          id: 'perm-suite',
          toolName: 'Bash',
          toolUseId: 'toolu_suite',
          input: { command: 'pnpm test', description: 'Run the tests' },
          description: `The agent will run this in ${CWD}.`,
        },
      }),
      status('awaiting_approval'),
      context(9),
    ),
    6 * MINUTE,
  )
}

export function homeSeeds(): SessionSeed[] {
  return [landingSeed(), checkoutSeed(), reviewSeed()]
}
