import { createHash } from 'node:crypto'
import { parseUserQuestions, type PermissionRequest, type SessionInfo } from '@workerdeck/protocol'
import type { ApnsRequest } from './client.ts'

// The wire contract with `apps/ios/WorkerDeckKit/Sources/WorkerDeckActivity`. Every field name here
// is decoded by name over there, and `packages/cli/test/live-activity.test.ts` writes the fixtures
// that Swift test asserts against - rename a field on one side only and that test fails.
export type ActivityAttributes = {
  sessionId: string
  hostId?: string
  engine?: string
  cwdLeaf: string
}

export type ActivityChoice = { index: number; label: string }

export type ActivityRequestState = {
  id: string
  kind: 'permission' | 'question' | 'plan'
  choices: ActivityChoice[]
  inputJSON?: string
}

export type ActivityContentState = {
  phase: ActivityPhaseName
  title: string
  headline: string
  detail?: string
  startedAtMs: number
  expiresAtMs?: number
  pendingCount: number
  steps?: { done: number; total: number }
  request?: ActivityRequestState
  epoch?: number
  seq?: number
  // Always null on the wire. The app writes a value locally between an intent's tap and the
  // server's answer, and every push from here is what clears it.
  decision: null
}

export type ActivityPhaseName = 'running' | 'approval' | 'question' | 'plan' | 'done' | 'failed' | 'parked' | 'ended'

export type LiveActivityPushKind = 'start' | 'update' | 'end'

const MAX_PAYLOAD_BYTES = 3800
const LIMIT = { title: 60, headline: 120, detail: 200, choiceLabel: 40, choices: 4 } as const
const STALE_MS = 20 * 60 * 1000
const DISMISSAL_MS = 15 * 60 * 1000
// Constant, and deliberately short. "Latest timestamp wins" only holds among pushes still
// deliverable when an offline phone reconnects, so an urgent update must not outlive the
// resolution that followed it and re-raise an answered question.
const EXPIRATION_MS = 10 * 60 * 1000
const END_EXPIRATION_MS = 4 * 60 * 60 * 1000

const RELEVANCE: Record<ActivityPhaseName, number> = {
  approval: 100,
  question: 100,
  plan: 100,
  running: 50,
  done: 10,
  failed: 10,
  parked: 10,
  ended: 10,
}

// Where a tool's one interesting argument lives, in the order a card should prefer them.
const PREVIEW_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'notebook_path', 'prompt', 'description'] as const

function clamp(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

export function sessionLabel(info: SessionInfo): string {
  const title = info.title?.trim()
  if (title !== undefined && title !== '') {
    return title
  }
  return cwdLeaf(info.cwd) || info.id
}

export function cwdLeaf(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) ?? ''
}

function previewOf(input: Record<string, unknown>): string | undefined {
  for (const key of PREVIEW_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return value
    }
  }
  return undefined
}

function requestKind(request: PermissionRequest): ActivityRequestState['kind'] {
  if (request.toolName === 'ExitPlanMode') {
    return 'plan'
  }
  return request.toolName === 'AskUserQuestion' && parseUserQuestions(request.input).length > 0 ? 'question' : 'permission'
}

// Real option buttons only when the whole answer fits one tap: one question, single-select, and few
// enough options to draw. Anything else gets the question text and "Answer in app", because a card
// that answers the first of three questions and drops the rest is worse than one that opens the app.
function choicesFor(request: PermissionRequest, kind: ActivityRequestState['kind']): ActivityChoice[] {
  if (kind !== 'question') {
    return []
  }
  const questions = parseUserQuestions(request.input)
  const [question] = questions
  if (questions.length !== 1 || question === undefined || question.multiSelect === true || question.options.length > LIMIT.choices) {
    return []
  }
  return question.options.map((option, index) => ({ index, label: clamp(option.label, LIMIT.choiceLabel) }))
}

function phaseFor(info: SessionInfo, request: PermissionRequest | undefined): ActivityPhaseName {
  switch (info.status) {
    case 'awaiting_approval': {
      if (request === undefined) {
        return 'running'
      }
      const kind = requestKind(request)
      return kind === 'permission' ? 'approval' : kind
    }
    case 'parked': {
      return 'parked'
    }
    case 'failed': {
      return 'failed'
    }
    case 'closed': {
      return 'ended'
    }
    case 'idle': {
      return 'done'
    }
    default: {
      return 'running'
    }
  }
}

function headlineFor(info: SessionInfo, phase: ActivityPhaseName, request: PermissionRequest | undefined): string {
  if (request !== undefined && (phase === 'approval' || phase === 'question' || phase === 'plan')) {
    if (phase === 'question') {
      const [question] = parseUserQuestions(request.input)
      return clamp(question?.header !== undefined && question.header !== '' ? question.header : 'A question', LIMIT.headline)
    }
    if (phase === 'plan') {
      return 'Plan ready for review'
    }
    return clamp(request.title ?? request.displayName ?? request.toolName, LIMIT.headline)
  }
  if (phase === 'running') {
    const active = info.checklist?.find((item) => item.status === 'in_progress')
    return clamp(active?.text ?? 'Working…', LIMIT.headline)
  }
  const finals: Partial<Record<ActivityPhaseName, string>> = {
    done: 'Turn finished',
    failed: 'Session failed',
    parked: 'Parked',
    ended: 'Session ended',
  }
  return finals[phase] ?? ''
}

function detailFor(phase: ActivityPhaseName, request: PermissionRequest | undefined): string | undefined {
  if (request === undefined) {
    return undefined
  }
  if (phase === 'question') {
    const [question] = parseUserQuestions(request.input)
    return question === undefined ? undefined : clamp(question.question, LIMIT.detail)
  }
  if (phase === 'approval' || phase === 'plan') {
    const preview = previewOf(request.input) ?? request.description
    return preview === undefined ? undefined : clamp(preview, LIMIT.detail)
  }
  return undefined
}

export function attributesFor(info: SessionInfo, hostId: string | undefined): ActivityAttributes {
  return {
    sessionId: info.id,
    ...(hostId === undefined ? {} : { hostId }),
    ...(info.engine === undefined ? {} : { engine: info.engine }),
    cwdLeaf: cwdLeaf(info.cwd),
  }
}

export function projectContentState(options: {
  info: SessionInfo
  request?: PermissionRequest
  startedAtMs: number
  finalPhase?: ActivityPhaseName
  finalHeadline?: string
}): ActivityContentState {
  const { info, request, startedAtMs } = options
  const phase = options.finalPhase ?? phaseFor(info, request)
  const kind = request === undefined ? undefined : requestKind(request)
  const choices = request === undefined || kind === undefined ? [] : choicesFor(request, kind)
  const total = info.checklist?.length ?? 0

  return {
    phase,
    title: clamp(sessionLabel(info), LIMIT.title),
    headline: options.finalHeadline ?? headlineFor(info, phase, request),
    ...(detailFor(phase, request) === undefined ? {} : { detail: detailFor(phase, request) }),
    startedAtMs,
    ...(request?.expiresAt === undefined ? {} : { expiresAtMs: request.expiresAt }),
    pendingCount: info.pendingPermissionCount,
    ...(total === 0 ? {} : { steps: { done: info.checklist!.filter((item) => item.status === 'completed').length, total } }),
    ...(request === undefined || kind === undefined
      ? {}
      : {
          request: {
            id: request.id,
            kind,
            choices,
            // Only worth carrying when it is what enables the buttons: an answer is encoded by
            // rewriting the original input, so without choices there is nothing to rewrite.
            ...(choices.length === 0 ? {} : { inputJSON: JSON.stringify(request.input) }),
          },
        }),
    ...(info.epoch === undefined ? {} : { epoch: info.epoch }),
    seq: info.lastSeq,
    decision: null,
  }
}

// Hashes what the card *draws*, so a push is only spent on a visible change. `seq` and `epoch` are
// deep-link freight that moves on every event, `decision` is the phone's; hashing any of them would
// make every tool call a push and defeat the throttle entirely.
export function contentHash(state: ActivityContentState): string {
  const { seq: _seq, epoch: _epoch, decision: _decision, ...drawn } = state
  return createHash('sha256').update(JSON.stringify(drawn)).digest('base64url').slice(0, 22)
}

// Shrinks in the order that costs the card least: the answer buttons go before any text does,
// because a question the user has to open the app for still reads correctly.
function shrink(state: ActivityContentState): ActivityContentState | undefined {
  if (state.request?.inputJSON !== undefined) {
    return { ...state, request: { ...state.request, choices: [], inputJSON: undefined } }
  }
  if (state.detail !== undefined && state.detail.length > 24) {
    return { ...state, detail: clamp(state.detail, Math.floor(state.detail.length / 2)) }
  }
  if (state.detail !== undefined) {
    return { ...state, detail: undefined }
  }
  if (state.headline.length > 24) {
    return { ...state, headline: clamp(state.headline, Math.floor(state.headline.length / 2)) }
  }
  return undefined
}

export function buildLiveActivityPush(
  kind: LiveActivityPushKind,
  options: {
    attributes: ActivityAttributes
    state: ActivityContentState
    urgent?: boolean
    now?: number
  },
): Omit<ApnsRequest, 'deviceToken' | 'environment'> {
  const now = options.now ?? Date.now()
  const seconds = Math.floor(now / 1000)
  let state = options.state

  const build = (content: ActivityContentState): Record<string, unknown> => ({
    aps: {
      timestamp: seconds,
      event: kind,
      ...(kind === 'start'
        ? {
            'attributes-type': 'SessionActivityAttributes',
            attributes: options.attributes,
            // Apple requires an alert on a start. Terse on purpose: the ordinary permission push
            // already rang the phone with its authenticated actions, and a second sound for the
            // same request is noise.
            alert: { title: content.title, body: content.phase === 'running' ? 'working' : 'approval needed' },
            'input-push-token': 1,
          }
        : {}),
      'content-state': content,
      ...(kind === 'end'
        ? { 'dismissal-date': Math.floor((now + DISMISSAL_MS) / 1000) }
        : { 'stale-date': Math.floor((now + STALE_MS) / 1000) }),
      'relevance-score': RELEVANCE[content.phase],
    },
  })

  let payload = build(state)
  while (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
    const smaller = shrink(state)
    if (smaller === undefined) {
      break
    }
    state = smaller
    payload = build(state)
  }

  return {
    payload,
    pushType: 'liveactivity',
    priority: kind === 'update' && options.urgent !== true ? 5 : 10,
    expiration: Math.floor((now + (kind === 'end' ? END_EXPIRATION_MS : EXPIRATION_MS)) / 1000),
  }
}
