import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { isSlashCommand, type Runner } from '@workerdeck/core'
import {
  CLIENT_ID_MAX,
  CONVERSATION_ENDED_CLOSE_CODE,
  PROTOCOL_VERSION,
  SHELL_COMMAND_MAX,
  type ClientFrame,
  type ServerFrame,
  type SessionEvent,
  type SessionInfo,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { bypassDisabled, permissionDecision, refuseJobInput, refusePermissionMode } from '../lib/permissions.ts'
import { engineOf } from '../lib/profile-env.ts'
import { CUT_IN_PROGRESS } from '../services/lifecycle-locks.ts'
import { CONVERSATION_ENDED } from '../services/conversation-cuts.ts'
import { mentionsFor } from '../services/peers.ts'
import type { PromptOutcome } from '../services/prompt-acks.ts'
import { shownEntryInfo } from './conversations.ts'
import { sleepRunner } from './sleep.ts'
import { takesLocalCommands } from '../services/shell-directory.ts'
import { shellPermitted, SHELL_REFUSAL, startShell, type ShellRegistry, type ShellSink, type ShellSize } from '../services/shells.ts'

// What the upgrade established about the principal; computed once there so the attach never re-authenticates.
export type AttachAccess = { operator: boolean }

// One per socket: its send path, its outbound backlog, and the shells it is attached to (shell id to the registry's detach).
type Client = { send: (frame: ServerFrame) => void; open: () => boolean; buffered: () => number; shells: Map<string, () => void> }

export const SHELL_SOCKET_BUFFERED_MAX = 4 * 1024 * 1024
export const SHELL_DETACHED_BACKPRESSURE = 'backpressure'
export const SESSION_SOCKET_BUFFERED_MAX = 16 * 1024 * 1024
export const SESSION_SOCKET_BACKPRESSURE_CODE = 1013
// A cut rolled back under a live socket: nothing moved on, so a reconnect attaches the same conversation.
export const CONVERSATION_KEPT_CODE = 1012

export function attachClient(ctx: ServerContext, ws: WebSocket, runner: Runner, req: IncomingMessage, access: AttachAccess): void {
  const { bridge, parking } = ctx
  const url = new URL(req.url ?? '/', 'http://internal')
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0
  const truncateResults = url.searchParams.get('truncateResults') === '1'
  const imageRefs = url.searchParams.get('imageRefs') === '1'

  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }
  const client: Client = { send, open: () => ws.readyState === ws.OPEN, buffered: () => ws.bufferedAmount, shells: new Map() }
  const conversation = ctx.records.conversationOf(runner.id) ?? 1

  send({
    type: 'attached',
    protocolVersion: PROTOCOL_VERSION,
    session: ctx.projects.withProject(runner.info()),
    replayingFrom: afterSeq,
    acks: true,
    ...(shellPermitted(ctx.shells, runner, access.operator) ? { shell: true } : {}),
    ...(ctx.pricingOverrides ? { pricingOverrides: ctx.pricingOverrides } : {}),
  })
  let live = false
  const unsubscribe = runner.subscribe(
    (event) => {
      // Replay is exempt: it is bounded by the log, and capping it would refuse every attach to a long session.
      if (live && ws.bufferedAmount > SESSION_SOCKET_BUFFERED_MAX) {
        ws.close(SESSION_SOCKET_BACKPRESSURE_CODE, 'backpressure')
        return
      }
      send({ type: 'event', event })
    },
    afterSeq,
    { coalesceReplay: true, truncateResults, imageRefs },
  )
  live = true
  const detachBridge = bridge.attach(runner.id, send)
  // Typed `/clear` prompts whose outcome is still to come; the announce settles them before this socket closes.
  const clears = new Map<string, (outcome: PromptOutcome) => void>()
  const leaveCut = ctx.cuts.socket(runner.id, {
    conversation,
    detach: () => {
      unsubscribe()
      detachBridge()
      detachShells(client)
    },
    announce: (next, epoch) => {
      for (const settle of clears.values()) {
        settle('executed')
      }
      send({ type: 'conversation_started', conversation: next, epoch })
      ws.close(CONVERSATION_ENDED_CLOSE_CODE, 'conversation started')
    },
    drop: () => ws.close(CONVERSATION_KEPT_CODE, 'conversation kept'),
  })
  const bound: Bound = { runner, access, client, conversation }

  // After the replay is wired, so a fresh reading arrives as a live event behind the history rather than racing it.
  // The replay faithfully re-installs whatever this session last heard, which on an idle session can be days old,
  // and until now nothing in an attach asked for a newer one. Throttled inside the runner; failures are silent by
  // design (the control request is experimental, and a missing usage reading is not an attach failure).
  void runner.refreshUsage?.().catch(() => {})

  let prompts = Promise.resolve()
  ws.on('message', (data: Buffer) => {
    let frame: ClientFrame
    try {
      frame = JSON.parse(data.toString('utf8')) as ClientFrame
    } catch {
      send({ type: 'protocol_error', message: 'invalid JSON frame' })
      return
    }
    const report = (error: unknown): void => {
      send({
        type: 'protocol_error',
        message: error instanceof Error ? error.message : 'command failed',
      })
    }
    const clientId =
      frame?.type === 'user_message' && typeof frame.clientId === 'string' && frame.clientId.length <= CLIENT_ID_MAX
        ? frame.clientId
        : undefined
    // Never defaulted: a frame with no conversation, or another one, is refused before anything runs or is acked as run.
    const refused = tokenRefusal(ctx, frame, bound)
    if (refused) {
      report(new Error(refused))
      if (clientId) {
        send(staleAck(ctx, runner.id, frame as Extract<ClientFrame, { type: 'user_message' }>, clientId))
      }
      return
    }
    // Prompts run in arrival order, and a close waits behind them: resolving mentions is async.
    if (frame?.type === 'close') {
      prompts = prompts.then(() => handleCommand(ctx, frame, bound).catch(report))
      return
    }
    if (frame?.type !== 'user_message') {
      handleCommand(ctx, frame, bound).catch(report)
      return
    }
    prompts = prompts.then(async () => {
      if (!clientId) {
        await handleCommand(ctx, frame, bound).catch(report)
        return
      }
      const key = `${runner.id}:${conversation}`
      if (isClearRequest(frame)) {
        await clearWithAck(ctx, frame, bound, key, clientId, clears, report)
        return
      }
      let unrun = false
      await ctx.promptAcks
        .run(key, clientId, () => handleCommand(ctx, frame, bound))
        .catch((error: unknown) => {
          unrun = error instanceof NotDelivered
          if (unrun) {
            ctx.promptAcks.record(key, clientId, 'notDelivered')
          }
          report(error)
        })
      send({ type: 'ack', clientId, ...(unrun ? { notDelivered: true as const } : {}) })
    })
  })
  ws.on('close', () => {
    // Detach only. The registry's watch(runner) owns the close and park kills; a socket going away must not end a shell.
    detachShells(client)
    unsubscribe()
    detachBridge()
    leaveCut()
    parking.onDetach(runner.id)
    ctx.engineSleep.onDetach(runner.id)
  })
}

export const ARCHIVE_UNREADABLE_CODE = 1011

// A past conversation: one replay of what the engine's store holds, then silence. Commands are refused, prompts acked.
export function attachArchive(
  ctx: ServerContext,
  ws: WebSocket,
  info: SessionInfo,
  events: readonly SessionEvent[] | undefined,
  req: IncomingMessage,
): void {
  const url = new URL(req.url ?? '/', 'http://internal')
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0
  // A cursor only skips rows in the log it was numbered in; without the archive's epoch it is a live cursor, so all rows go.
  const from = url.searchParams.get('epoch') === String(info.epoch) ? afterSeq : 0
  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }
  send({
    type: 'attached',
    protocolVersion: PROTOCOL_VERSION,
    session: shownEntryInfo(ctx, info),
    replayingFrom: afterSeq,
    acks: true,
  })
  if (!events) {
    send({ type: 'protocol_error', message: 'this conversation could not be read from the engine store; retrying' })
    ws.close(ARCHIVE_UNREADABLE_CODE, 'history unreadable')
    return
  }
  for (const event of events) {
    if (event.seq > from) {
      send({ type: 'event', event })
    }
  }
  ws.on('message', (data: Buffer) => {
    let frame: ClientFrame | undefined
    try {
      frame = JSON.parse(data.toString('utf8')) as ClientFrame
    } catch {
      frame = undefined
    }
    send({ type: 'protocol_error', message: 'conversation is archived' })
    if (frame?.type === 'user_message' && typeof frame.clientId === 'string' && frame.clientId.length <= CLIENT_ID_MAX) {
      send({ type: 'ack', clientId: frame.clientId })
    }
  })
}

// A socket is bound to the runner and the conversation it attached to; the stable id never routes it into the next one.
type Bound = { runner: Runner; access: AttachAccess; client: Client; conversation: number }

// A typed `/clear` is acked once its cut is known to have happened or not: a queued one waits for the next idle, and one
// whose cut closes this socket is acked just before the announce. A gateway restart before then leaves it uncertain.
async function clearWithAck(
  ctx: ServerContext,
  frame: ClientFrame,
  bound: Bound,
  key: string,
  clientId: string,
  clears: Map<string, (outcome: PromptOutcome) => void>,
  report: (error: unknown) => void,
): Promise<void> {
  const { client, conversation, runner } = bound
  if (!ctx.promptAcks.open(key, clientId)) {
    const known = ctx.promptAcks.outcome(key, clientId)
    if (known) {
      client.send(outcomeAck(clientId, known))
    }
    return
  }
  let settled = false
  const settle = (outcome: PromptOutcome): void => {
    if (settled) {
      return
    }
    settled = true
    clears.delete(clientId)
    ctx.promptAcks.record(key, clientId, outcome)
    client.send(outcomeAck(clientId, outcome))
  }
  clears.set(clientId, settle)
  try {
    await handleCommand(ctx, frame, bound, (cut) => settle(cut ? 'executed' : 'notDelivered'))
  } catch (error) {
    report(error)
    settle((ctx.records.conversationOf(runner.id) ?? 1) > conversation ? 'executed' : 'notDelivered')
  }
}

function outcomeAck(clientId: string, outcome: PromptOutcome): ServerFrame {
  return outcome === 'executed' ? { type: 'ack', clientId } : { type: 'ack', clientId, notDelivered: true }
}

async function handleCommand(ctx: ServerContext, frame: ClientFrame, bound: Bound, onClear?: (cut: boolean) => void): Promise<void> {
  const { attachmentStore, bridge } = ctx
  const { runner, access, client } = bound
  if (ctx.registry.get(runner.id) !== runner && !ctx.locks.gated(runner.id)) {
    throw new NotDelivered(CONVERSATION_ENDED)
  }
  if (tokenRefusal(ctx, frame, bound)) {
    throw new NotDelivered(CONVERSATION_ENDED)
  }
  if (ctx.locks.gated(runner.id)) {
    throw new NotDelivered(CUT_IN_PROGRESS)
  }
  if (isClearRequest(frame)) {
    if (await ctx.cuts.clearOnIdle(runner, 'clear', undefined, onClear)) {
      onClear?.(true)
    }
    return
  }
  switch (frame.type) {
    case 'user_message': {
      const locked = refuseJobInput(runner.info(), ctx.options.disableBypassPermissions)
      if (locked) {
        throw new NotDelivered(locked)
      }
      // The one place `mentions` is ever set: this frame is a person typing. A slash command is
      // matched on the whole message by the CLI, so nothing may be appended to one, and a failure
      // to resolve is silent - a hint must never lose the text it was a hint about.
      const mentions = ctx.peers && !isSlashCommand(frame.text) ? await mentionsFor(ctx.peers, runner.id, frame.text).catch(() => []) : []
      if (ctx.locks.gated(runner.id) || ctx.registry.get(runner.id) !== runner) {
        throw new NotDelivered(CUT_IN_PROGRESS)
      }
      if (tokenRefusal(ctx, frame, bound)) {
        throw new NotDelivered(CONVERSATION_ENDED)
      }
      const options = mentions.length > 0 ? { mentions } : undefined
      if (!frame.attachmentIds?.length) {
        runner.sendMessage(frame.text, undefined, options)
        return
      }
      const resolved = attachmentStore.resolve(runner.id, frame.attachmentIds)
      if (!resolved.ok) {
        throw new NotDelivered(`unknown attachment(s): ${resolved.missing.join(', ')}`)
      }
      runner.sendMessage(frame.text, resolved.attachments, options)
      return
    }
    case 'permission_decision': {
      runner.resolvePermission(frame.requestId, permissionDecision(frame))
      return
    }
    case 'interrupt': {
      await runner.interrupt()
      return
    }
    case 'sleep': {
      await sleepRunner(runner)
      return
    }
    case 'background_task': {
      if (!runner.backgroundTask) {
        throw new Error(`the ${engineOf(runner.info())} engine cannot move a task to the background`)
      }
      await runner.backgroundTask(frame.toolUseId)
      return
    }
    case 'set_permission_mode': {
      const refused = refusePermissionMode(frame.mode, {
        operator: access.operator,
        disableBypass: bypassDisabled(ctx.options.disableBypassPermissions),
      })
      if (refused) {
        throw new Error(refused)
      }
      await runner.setPermissionMode(frame.mode)
      return
    }
    case 'set_model': {
      await runner.setModel(frame.model)
      return
    }
    case 'set_effort': {
      if (!runner.setEffort) {
        throw new Error(`the ${engineOf(runner.info())} engine cannot change its reasoning effort`)
      }
      if (frame.effort !== undefined && typeof frame.effort !== 'string') {
        throw new Error('effort must be a string')
      }
      await runner.setEffort(frame.effort)
      return
    }
    case 'tool_call_result': {
      bridge.resolve(runner.id, frame.executionId, { output: frame.output, logs: frame.logs })
      return
    }
    case 'tool_call_error': {
      bridge.resolve(runner.id, frame.executionId, {
        reason: frame.reason,
        error: frame.error,
        logs: frame.logs,
      })
      return
    }
    case 'shell_command': {
      const shells = permittedShells(ctx, runner, access)
      if (typeof frame.command !== 'string' || frame.command.includes('\0')) {
        throw new Error('shell command must be a string')
      }
      if (frame.command.length > SHELL_COMMAND_MAX) {
        throw new Error(`shell command exceeds ${SHELL_COMMAND_MAX} characters`)
      }
      if (frame.command.trim() === '') {
        throw new Error('shell command is empty')
      }
      if (!takesLocalCommands(runner)) {
        throw new Error(`the ${engineOf(runner.info())} engine cannot take shell output`)
      }
      await startShell(shells, { runner, command: frame.command, owner: 'user' })
      return
    }
    case 'shell_attach': {
      // The size is a change to the shell, so only an attach naming this socket's conversation applies it.
      const size = frame.generation === bound.conversation ? { cols: frame.cols, rows: frame.rows } : undefined
      await attachShell(permittedShells(ctx, runner, access), client, runner.id, frame.shellId, size)
      return
    }
    case 'shell_input': {
      permittedShells(ctx, runner, access).write(runner.id, frame.shellId, frame.data)
      return
    }
    case 'shell_resize': {
      permittedShells(ctx, runner, access).resize(runner.id, frame.shellId, { cols: frame.cols, rows: frame.rows })
      return
    }
    case 'shell_detach': {
      detachShell(client, frame.shellId)
      return
    }
    case 'close': {
      runner.close('client')
      return
    }
    default: {
      throw new Error(`unknown command: ${(frame as { type?: string }).type}`)
    }
  }
}

// This attempt is refused and never runs; the ack reports what became of the prompt in the conversation it named.
// Ran there: a plain ack. Known refused there (or it named none): `notDelivered`. Forgotten: `uncertain`.
function staleAck(
  ctx: ServerContext,
  runnerId: string,
  frame: Extract<ClientFrame, { type: 'user_message' }>,
  clientId: string,
): ServerFrame {
  if (typeof frame.generation !== 'number') {
    return { type: 'ack', clientId, notDelivered: true }
  }
  const outcome = ctx.promptAcks.outcome(`${runnerId}:${frame.generation}`, clientId)
  if (outcome === 'executed') {
    return { type: 'ack', clientId }
  }
  return outcome === 'notDelivered' ? { type: 'ack', clientId, notDelivered: true } : { type: 'ack', clientId, uncertain: true }
}

// Refused before the engine saw it: a prompt refused this way is acked `notDelivered` and its text stays the sender's.
// Anything thrown once `sendMessage` may have run is a plain Error, so a possibly delivered prompt is never called unrun.
class NotDelivered extends Error {}

// Subscribing to a shell's output changes nothing (an untokened attach never resizes); every other command must name
// the socket's own conversation.
const UNTOKENED: ReadonlySet<string> = new Set(['shell_attach', 'shell_detach'])

function tokenRefusal(ctx: ServerContext, frame: ClientFrame, bound: Bound): string | undefined {
  if (UNTOKENED.has(frame?.type)) {
    return undefined
  }
  if (typeof frame?.generation !== 'number') {
    return `this command must name its conversation (generation); the socket is on conversation ${bound.conversation}`
  }
  if (frame.generation !== bound.conversation || (ctx.records.conversationOf(bound.runner.id) ?? 1) !== bound.conversation) {
    return CONVERSATION_ENDED
  }
  return undefined
}

// Exact: a typed `/clear` alone, nothing attached. Anything longer is ordinary text for the engine.
function isClearRequest(frame: ClientFrame): boolean {
  return frame.type === 'clear_context' || (frame.type === 'user_message' && frame.text.trim() === '/clear' && !frame.attachmentIds?.length)
}

function permittedShells(ctx: ServerContext, runner: Runner, access: AttachAccess): ShellRegistry {
  if (ctx.shells === null || !shellPermitted(ctx.shells, runner, access.operator)) {
    throw new Error(SHELL_REFUSAL)
  }
  return ctx.shells
}

async function attachShell(
  shells: ShellRegistry,
  client: Client,
  sessionId: string,
  shellId: string,
  size: ShellSize | undefined,
): Promise<void> {
  if (size) {
    shells.resize(sessionId, shellId, size)
  }
  let detach: (() => void) | undefined
  const drop = (reason: string): void => {
    if (detach === undefined || client.shells.get(shellId) !== detach) {
      return
    }
    client.shells.delete(shellId)
    detach()
    client.send({ type: 'shell_detached', shellId, reason })
  }
  const sink: ShellSink = {
    write: (data) => {
      if (client.buffered() > SHELL_SOCKET_BUFFERED_MAX) {
        drop(SHELL_DETACHED_BACKPRESSURE)
        return
      }
      client.send({ type: 'shell_output', shellId, data })
    },
    end: drop,
  }
  const attached = await shells.attach(sessionId, shellId, sink)
  if (!client.open()) {
    attached.detach()
    return
  }
  detachShell(client, shellId)
  if (attached.shell.status === 'running') {
    detach = attached.detach
    client.shells.set(shellId, detach)
  }
  const { shell, scrollback } = attached
  client.send({ type: 'shell_attached', shellId, shell, cols: shell.cols, rows: shell.rows, scrollback })
}

function detachShell(client: Client, shellId: string): void {
  client.shells.get(shellId)?.()
  client.shells.delete(shellId)
}

function detachShells(client: Client): void {
  for (const detach of client.shells.values()) {
    detach()
  }
  client.shells.clear()
}
