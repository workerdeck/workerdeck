import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import type { EngineAdapter, QuestionDirectory, SessionRunnerConfig } from '@workerdeck/core'
import {
  ENGINE_CAPABILITIES,
  questionBoardMarkdown,
  type AgentResponse,
  type MessageOrigin,
  type QuestionBoardResponse,
  type QuestionResponse,
  type QuestionsServerFrame,
} from '@workerdeck/protocol'
import { createWorkerServer } from '../src/index.ts'
import { createFileQuestionStore, createMemoryQuestionStore } from '../src/services/question-store.ts'
import { QuestionRefusal, QuestionService, type QuestionAgent } from '../src/services/questions.ts'
import { gatewayFixture, listenOn } from './helpers.ts'
import { PeerRunner } from './peer-runner.ts'

function claude(build: (config: SessionRunnerConfig, id: string | undefined) => PeerRunner): EngineAdapter {
  return {
    engine: 'claude',
    capabilities: ENGINE_CAPABILITIES.claude,
    catalog: { models: [], provenance: 'test' },
    checkAvailability: async () => ({ available: true }),
    createRunner: ({ config, id }) => build(config, id),
  }
}

const CLAUDE_DIR = '/tmp/wd-questions-claude'
const PROFILES = [{ name: 'default', engine: 'claude' as const, configDir: CLAUDE_DIR }]

type Delivered = { to: string; text: string; origin?: MessageOrigin }

function board(agents: QuestionAgent[], options: { unreachable?: string[] } = {}) {
  const delivered: Delivered[] = []
  const store = createMemoryQuestionStore()
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const service = new QuestionService({
    store,
    agent: (id) => byId.get(id),
    leads: (id) => agents.some((agent) => agent.lead === id),
    name: (id) => byId.get(id)?.name,
    human: () => 'tobias',
    deliver: async (to, text, origin) => {
      if (options.unreachable?.includes(to)) {
        return 'the session is gone'
      }
      delivered.push({ to, text, ...(origin ? { origin } : {}) })
      return undefined
    },
    now: () => Date.UTC(2026, 9, 23),
  })
  return { service, delivered, store }
}

const TEAM: QuestionAgent[] = [
  { id: 'lead', name: 'Lead' },
  { id: 'pylon', name: 'Pylon', lead: 'lead' },
  { id: 'docs', name: 'Docs', lead: 'lead' },
]

const ASK = {
  title: 'Monthly or yearly billing first?',
  context: 'Stripe only has monthly prices today.',
  options: [
    { key: 'A', label: 'Monthly first' },
    { key: 'B', label: 'Both at once' },
  ],
  recommend: 'A',
  why: 'Ships a week earlier',
  blocking: 'uncommitted change in apps/billing',
}

describe('QuestionService', () => {
  it('puts a member on its lead board as a draft and tells the lead', async () => {
    const { service, delivered } = board(TEAM)
    expect(await service.ask('pylon', ASK)).toContain('draft for your lead Lead')
    expect(service.boardOf('pylon')).toEqual({ id: 'lead', team: true })
    const item = service.board('lead', { drafts: true })!.items[0]!
    expect(item).toMatchObject({ n: 1, status: 'draft', asker: 'pylon', askerName: 'Pylon', recommendation: { choice: 'A' } })
    expect(service.board('lead')!.items).toEqual([])
    expect(delivered).toEqual([expect.objectContaining({ to: 'lead', origin: { kind: 'peer', sessionId: 'pylon', name: 'Pylon' } })])
  })

  it('opens the lead own items at once, and a lone session gets its own board', async () => {
    const { service } = board(TEAM)
    await service.ask('lead', { title: 'Lead question' })
    await service.ask('solo', { title: 'Solo question' })
    expect(service.board('lead')!.items[0]!.status).toBe('open')
    expect(service.boardOf('solo')).toEqual({ id: 'solo', team: false })
    expect(service.board('solo')!.items[0]!.status).toBe('open')
  })

  it('lets only the lead publish or reject a draft, and tells the asker of a rejection', async () => {
    const { service, delivered } = board(TEAM)
    await service.ask('pylon', ASK)
    await expect(service.update('pylon', { n: 1, publish: true })).rejects.toThrow('only the lead publishes')
    await expect(service.closeItem('docs', { n: 1, reason: 'resolved' })).rejects.toThrow('not yours')
    expect(await service.update('lead', { n: 1, publish: true })).toContain('Published #1')
    expect(service.board('lead')!.items[0]!.status).toBe('open')

    await service.ask('docs', { title: 'Duplicate' })
    expect(await service.closeItem('lead', { n: 2, reason: 'rejected', note: 'same as #1' })).toBe('Rejected #2.')
    expect(delivered.at(-1)).toMatchObject({ to: 'docs', text: expect.stringContaining('rejected by your lead: same as #1') })
  })

  it('delivers a human answer, unoriginated, to the asker, the lead and every waiting session', async () => {
    const { service, delivered } = board(TEAM)
    await service.ask('lead', { ...ASK, waiting: ['pylon', 'docs', 'lead'] })
    delivered.length = 0
    const { item, delivery } = await service.answer('lead', 1, { choice: 'A', text: 'but only for EU' }, 'tobias')
    expect(item).toMatchObject({
      status: 'answered',
      answer: { choice: 'A', text: 'but only for EU', by: 'tobias' },
      waiting: ['pylon', 'docs'],
    })
    expect(delivery).toEqual({ delivered: ['lead', 'pylon', 'docs'], undelivered: [] })
    expect(delivered.every((entry) => entry.origin === undefined)).toBe(true)
    expect(delivered[0]!.text).toContain('answered by tobias: A (Monthly first): but only for EU')
    await expect(service.answer('lead', 1, { choice: 'B' }, 'tobias')).rejects.toThrow('already answered')
  })

  it('refuses an answer to a draft, an unknown option, or an empty one', async () => {
    const { service } = board(TEAM)
    await service.ask('pylon', ASK)
    await expect(service.answer('lead', 1, { choice: 'A' }, 'tobias')).rejects.toThrow('draft')
    await service.update('lead', { n: 1, publish: true })
    await expect(service.answer('lead', 1, { choice: 'C' }, 'tobias')).rejects.toThrow('no option C')
    await expect(service.answer('lead', 1, {}, 'tobias')).rejects.toBeInstanceOf(QuestionRefusal)
  })

  it('records an answer given elsewhere only from the lead, attributed to the human and carried as the lead', async () => {
    const { service, delivered } = board(TEAM)
    await service.ask('pylon', ASK)
    await expect(service.recordAnswer('pylon', { n: 1, choice: 'A' })).rejects.toThrow('only the lead')
    delivered.length = 0
    expect(await service.recordAnswer('lead', { n: 1, choice: 'B' })).toContain('Told Pylon')
    expect(service.board('lead')!.items[0]!.answer).toMatchObject({ choice: 'B', by: 'tobias', recordedBy: 'lead' })
    expect(delivered).toEqual([expect.objectContaining({ to: 'pylon', origin: { kind: 'peer', sessionId: 'lead', name: 'Lead' } })])
  })

  it('keeps who an answer could not reach on the item', async () => {
    const { service } = board(TEAM, { unreachable: ['pylon'] })
    await service.ask('lead', { title: 'Q', waiting: ['pylon'] })
    const { item, delivery } = await service.answer('lead', 1, { text: 'yes' }, 'tobias')
    expect(delivery).toEqual({ delivered: ['lead'], undelivered: ['pylon'] })
    expect(item.undelivered).toEqual(['pylon'])
    expect(await service.list('pylon', { filter: 'waiting' })).toContain('answered 2026-10-23 by tobias: yes')
  })

  it('edits only unanswered items, by their asker or the lead, and follows up under a parent', async () => {
    const { service } = board(TEAM)
    await service.ask('pylon', ASK)
    await expect(service.update('docs', { n: 1, title: 'mine now' })).rejects.toThrow('not yours')
    await service.update('pylon', { n: 1, blocking: '', options: [{ key: 'A', label: 'Monthly' }] })
    const item = service.board('lead', { drafts: true })!.items[0]!
    expect(item.blocking).toBeUndefined()
    expect(item.options).toEqual([{ key: 'A', label: 'Monthly' }])
    await expect(service.update('pylon', { n: 1, recommend: 'Z' })).rejects.toThrow('not one of the options')
    await service.recordAnswer('lead', { n: 1, choice: 'A' })
    await expect(service.update('pylon', { n: 1, title: 'late' })).rejects.toThrow('follow-up')
    await service.ask('pylon', { title: 'And yearly later?', parent: 1 })
    expect(service.board('lead', { drafts: true })!.items[1]).toMatchObject({ n: 2, parent: 1 })
    await expect(service.ask('pylon', { title: 'x', parent: 9 })).rejects.toThrow('no item #9')
  })

  it('survives a restart through the file store, numbering on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wd-questions-'))
    try {
      const deps = {
        agent: () => undefined,
        leads: () => false,
        name: () => undefined,
        human: () => 'tobias',
        deliver: async () => undefined,
      }
      const first = new QuestionService({ ...deps, store: createFileQuestionStore(dir) })
      await first.ask('s1', { title: 'one' })
      first.stop()
      await expect(first.ask('s1', { title: 'late' })).rejects.toThrow('closing')
      const second = new QuestionService({ ...deps, store: createFileQuestionStore(dir) })
      await second.ask('s1', { title: 'two' })
      expect(second.board('s1')!.items.map((item) => [item.n, item.title])).toEqual([
        [1, 'one'],
        [2, 'two'],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exports a board as markdown on request', async () => {
    const { service } = board(TEAM)
    await service.ask('lead', ASK)
    await service.ask('lead', { title: 'Done one' })
    await service.answer('lead', 2, { text: 'fine' }, 'tobias')
    const { board: info, items } = service.board('lead')!
    const markdown = questionBoardMarkdown(info, items)
    expect(markdown).toContain('### #1 Monthly or yearly billing first?')
    expect(markdown).toContain('**Blocking:** uncommitted change in apps/billing')
    expect(markdown).toContain('- **A**: Monthly first **(recommended)**')
    expect(markdown).toContain('- **#2** Done one (2026-10-23, tobias): fine')
  })
})

describe('the question board on a gateway', () => {
  const { servers, cleanup } = gatewayFixture('wd-questions-gw-')
  beforeAll(() => mkdirSync(CLAUDE_DIR, { recursive: true }))
  afterEach(cleanup)

  it('offers the tools to every session and delivers a REST answer into the asker', async () => {
    const runners = new Map<string, PeerRunner>()
    const configs = new Map<string, SessionRunnerConfig>()
    let minted = 0
    const server = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: PROFILES,
      engines: {
        claude: claude((config, given) => {
          const id = given ?? `s${++minted}`
          const runner = new PeerRunner(id)
          runners.set(id, runner)
          configs.set(id, config)
          return runner
        }),
      },
    })
    servers.push(server)
    const { base } = await listenOn(server)
    const post = async <T>(path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: (await res.json()) as T }
    }
    const lead = (await post<AgentResponse>('/agents', { name: 'Lead', config: { cwd: '/tmp' } })).body.agent
    const member = (await post<AgentResponse>('/agents', { name: 'Pylon', lead: lead.id, config: { cwd: '/tmp' } })).body.agent
    const tools = (id: string): QuestionDirectory => configs.get(id)!.questions!
    expect(configs.get(member.id)!.questions).toBeDefined()
    const frames: QuestionsServerFrame[] = []
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/questions/ws`)
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as QuestionsServerFrame))
    await vi.waitFor(() => expect(frames[0]).toEqual({ type: 'questions_attached', protocolVersion: expect.any(Number), boards: [] }))

    expect(await tools(member.id).ask(member.id, ASK)).toContain('draft for your lead Lead')
    expect(runners.get(lead.id)!.sent.at(-1)!.text).toContain('Draft #1')
    await tools(lead.id).update(lead.id, { n: 1, publish: true })

    const boards = (await (await fetch(`${base}/questions`)).json()) as { boards: Array<{ id: string; open: number; blocking: number }> }
    expect(boards.boards).toEqual([expect.objectContaining({ id: lead.id, name: 'Lead', team: true, open: 1, blocking: 1 })])
    const listed = (await (await fetch(`${base}/questions/${lead.id}`)).json()) as QuestionBoardResponse
    expect(listed.items.map((item) => item.title)).toEqual([ASK.title])

    const answered = await post<QuestionResponse>(`/questions/${lead.id}/1/answer`, { choice: 'A' })
    expect(answered.status).toBe(200)
    expect(answered.body.delivery).toEqual({ delivered: [member.id, lead.id], undelivered: [] })
    await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ type: 'questions_changed', board: { id: lead.id, open: 0, answered: 1 } }))
    expect(frames.map((frame) => frame.type === 'questions_changed' && [frame.board.drafts, frame.board.open])).toEqual([
      false,
      [1, 0],
      [0, 1],
      [0, 0],
    ])
    socket.close()
    const sent = runners.get(member.id)!.sent.at(-1)!
    expect(sent.text).toContain('answered by operator: A (Monthly first)')
    expect(sent.options?.origin).toBeUndefined()
    expect((await post<{ error: string }>(`/questions/${lead.id}/1/answer`, { choice: 'B' })).status).toBe(409)
    expect((await fetch(`${base}/questions/nope`)).status).toBe(404)
    const markdown = await fetch(`${base}/questions/${lead.id}?format=md`)
    expect(markdown.headers.get('content-type')).toContain('text/markdown')
    expect(await markdown.text()).toContain('# Questions: Lead')
  })

  it('stays off when the host turns it off', async () => {
    const configs: SessionRunnerConfig[] = []
    const server = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      questions: { enabled: false },
      profiles: PROFILES,
      engines: {
        claude: claude((config) => {
          configs.push(config)
          return new PeerRunner('s1')
        }),
      },
    })
    servers.push(server)
    const { base } = await listenOn(server)
    await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp' }),
    })
    expect(configs[0]!.questions).toBeUndefined()
    expect((await fetch(`${base}/questions`)).status).toBe(404)
    const refused = new WebSocket(`${base.replace(/^http/, 'ws')}/questions/ws`)
    const status = await new Promise<number | undefined>((resolve) => {
      refused.on('unexpected-response', (_req, res) => resolve(res.statusCode))
      refused.on('open', () => resolve(101))
    })
    expect(status).toBe(404)
  })
})
