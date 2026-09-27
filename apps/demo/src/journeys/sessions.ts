import { beat, context, patch, peerMessage, peerSend, resolved, result, say, status, tool, turnEnd } from '../stage/tape.ts'
import type { Journey } from '../tour/types.ts'
import { agent, homeSeeds, PROFILES } from './fixtures.ts'

const HERO = 'hero'
const PRICING = 'pricing'

const LANDING = { sessionId: 'landing', name: 'Spring launch landing page' }
const CHECKOUT = { sessionId: 'checkout', name: 'Fix the flaky checkout test' }
const QUESTION = 'Should the pricing section show the cart total?'
const ANSWER = 'Yes, but use useCartTotal(). It waits until prices have loaded.'

const DELEGATE = beat(
  status('running'),
  400,
  say('I will build this with two helpers working in parallel: one for the hero, one for pricing.', { stream: true }),
  1200,
  tool(HERO, 'Task', { description: 'Build the hero section', subagent_type: 'general-purpose' }),
  patch({ subagents: [agent(HERO, 'Build the hero section', 'running')] }),
  1000,
  tool(PRICING, 'Task', { description: 'Build the pricing section', subagent_type: 'general-purpose' }),
  patch({ subagents: [agent(HERO, 'Build the hero section', 'running', 1), agent(PRICING, 'Build the pricing section', 'running')] }),
  context(30),
)

const FINISH = beat(
  4000,
  result(PRICING, 'Added the pricing section with three plans.'),
  patch({ subagents: [agent(HERO, 'Build the hero section', 'running', 3), agent(PRICING, 'Build the pricing section', 'done', 2)] }),
  3000,
  result(HERO, 'Added the hero section with the launch headline.'),
  patch({ subagents: [agent(HERO, 'Build the hero section', 'done', 3), agent(PRICING, 'Build the pricing section', 'done', 2)] }),
  400,
  say('The landing page is ready: a hero and a pricing section, each built by its own helper.', { stream: true }),
  context(38),
  turnEnd({ durationMs: 96_000, totalCostUsd: 1.12, numTurns: 2 }),
)

const APPROVED = beat(
  resolved('perm-suite'),
  status('running'),
  2500,
  result('toolu_suite', 'Tests  45 passed (45)'),
  400,
  say('All tests pass. PR #412 is good to merge.', { stream: true }),
  turnEnd({ durationMs: 38_000, totalCostUsd: 0.14, numTurns: 1 }),
)

const DENIED = beat(
  resolved('perm-suite', 'deny'),
  400,
  say('Okay, I will not run the tests.', { stream: true }),
  turnEnd({ totalCostUsd: 0.1 }),
)

const ASK_PEER = beat(
  status('running'),
  400,
  say('The checkout session owns the cart code, so I will ask it.', { stream: true }),
  800,
  peerSend('peer-ask', CHECKOUT, QUESTION, 1500),
  turnEnd({ durationMs: 9_000, totalCostUsd: 1.15, numTurns: 3 }),
)

const PEER_REPLIES = beat(
  1200,
  peerMessage({ ...LANDING, engine: 'claude' }, QUESTION),
  1500,
  peerSend('peer-reply', LANDING, ANSWER, 1500),
)

const USE_ANSWER = beat(
  1500,
  peerMessage({ ...CHECKOUT, engine: 'codex' }, ANSWER),
  status('running'),
  400,
  say('Got it. The pricing section now shows the total with `useCartTotal()`.', { stream: true }),
  turnEnd({ durationMs: 18_000, totalCostUsd: 1.21, numTurns: 4 }),
)

export const sessionsJourney: Journey = {
  id: 'sessions',
  title: 'How sessions work',
  summary: 'Run Claude and Codex side by side, hand work to sub-agents, and let sessions talk to each other.',
  regions: ['section:sessions', 'agent-panel'],
  scene: () => ({ seeds: homeSeeds(), profiles: PROFILES, selected: 'landing' }),
  async run(d) {
    await d.explain({
      focus: 'section:sessions',
      title: 'All your agents in one list',
      body: 'Each card is a running agent session. Claude and Codex sit side by side in the same list.',
    })
    await d.explain({
      focus: 'card:review',
      title: 'See who needs you',
      body: 'This session is waiting for your approval, so its card is flagged.',
    })
    await d.explain({
      focus: 'agent-panel',
      title: 'The Agent panel',
      body: 'Click a card to open the session here. It reads like Claude Code in a terminal.',
    })
    await d.hint('landing', 'Build the landing page with sub-agents', {
      focus: 'agent-panel',
      title: 'Give it a task',
      body: 'Click the highlighted prompt to send it.',
    })
    await d.play('landing', DELEGATE)
    const finishing = d.play('landing', FINISH)
    await d.explain({
      focus: 'card:landing',
      title: 'Sub-agents on the card',
      body: 'Each sub-agent shows up on the card with its own progress. Click one to follow just that thread.',
    })
    await finishing
    await d.explain({
      focus: 'css:.term-scrubber',
      title: 'The scrubber',
      body: 'A map of the whole conversation. Your prompts are marked on the left, finished turns on the right. Click anywhere to jump there.',
    })
    d.select('review')
    const decision = await d.until((command) => command.sessionId === 'review' && command.frame.type === 'permission_decision', {
      focus: 'agent-panel',
      title: 'You stay in control',
      body: 'The review session wants to run the tests. Approve it right here in the panel.',
      waiting: 'Waiting for your answer',
    })
    const denied = decision?.frame.type === 'permission_decision' && decision.frame.behavior === 'deny'
    await d.play('review', denied ? DENIED : APPROVED)
    d.select('landing')
    await d.hint('landing', 'Ask the checkout session about the cart total', {
      focus: 'agent-panel',
      title: 'Sessions can talk',
      body: 'Sessions on the same machine can message each other. Try it.',
    })
    await d.play('landing', ASK_PEER)
    d.select('checkout')
    await d.play('checkout', PEER_REPLIES)
    await d.explain({
      focus: 'agent-panel',
      title: 'Codex got the message',
      body: 'The question arrived in the Codex session, marked with who sent it, and Codex answered.',
    })
    d.select('landing')
    await d.play('landing', USE_ANSWER)
    await d.explain({
      focus: 'status-bar',
      title: 'Always in view',
      body: 'The status bar tracks the session you are looking at: status, context, usage limits, model and permission mode.',
      next: 'Finish',
    })
  },
}
