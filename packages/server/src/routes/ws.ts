import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { isSlashCommand, type Runner } from '@workerdeck/core'
import { PROTOCOL_VERSION, SHELL_COMMAND_MAX, type ClientFrame, type ServerFrame } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { shellPermitted, SHELL_REFUSAL, type ShellRegistry, type ShellSink, type ShellSize } from '../services/shells.ts'

// What the upgrade established about the principal; computed once there so the attach never re-authenticates.
export type AttachAccess = { operator: boolean }

// One per socket: its send path, its outbound backlog, and the shells it is attached to (shell id to the registry's detach).
type Client = { send: (frame: ServerFrame) => void; open: () => boolean; buffered: () => number; shells: Map<string, () => void> }

export const SHELL_SOCKET_BUFFERED_MAX = 4 * 1024 * 1024
export const SHELL_DETACHED_BACKPRESSURE = 'backpressure'

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

  send({
    type: 'attached',
    protocolVersion: PROTOCOL_VERSION,
    session: ctx.projects.withProject(runner.info()),
    replayingFrom: afterSeq,
    ...(shellPermitted(ctx.shells, runner, access.operator) ? { shell: true } : {}),
    ...(ctx.pricingOverrides ? { pricingOverrides: ctx.pricingOverrides } : {}),
  })
  const unsubscribe = runner.subscribe((event) => send({ type: 'event', event }), afterSeq, {
    coalesceReplay: true,
    truncateResults,
    imageRefs,
  })
  const detachBridge = bridge.attach(runner.id, send)

  // After the replay is wired, so a fresh reading arrives as a live event behind the history rather than racing it.
  // The replay faithfully re-installs whatever this session last heard, which on an idle session can be days old,
  // and until now nothing in an attach asked for a newer one. Throttled inside the runner; failures are silent by
  // design (the control request is experimental, and a missing usage reading is not an attach failure).
  void runner.refreshUsage?.().catch(() => {})

  ws.on('message', (data: Buffer) => {
    let frame: ClientFrame
    try {
      frame = JSON.parse(data.toString('utf8')) as ClientFrame
    } catch {
      send({ type: 'protocol_error', message: 'invalid JSON frame' })
      return
    }
    handleCommand(ctx, frame, runner, access, client).catch((error: unknown) => {
      send({
        type: 'protocol_error',
        message: error instanceof Error ? error.message : 'command failed',
      })
    })
  })
  ws.on('close', () => {
    // Detach only. The registry's watch(runner) owns the close and park kills; a socket going away must not end a shell.
    detachShells(client)
    unsubscribe()
    detachBridge()
    parking.onDetach(runner.id)
  })
}

async function handleCommand(ctx: ServerContext, frame: ClientFrame, runner: Runner, access: AttachAccess, client: Client): Promise<void> {
  const { attachmentStore, bridge } = ctx
  switch (frame.type) {
    case 'user_message': {
      // The one place `mentions` is ever set: this frame is a person typing. A slash command is
      // matched on the whole message by the CLI, so nothing may be appended to one, and a failure
      // to resolve is silent - a hint must never lose the text it was a hint about.
      const mentions = ctx.peers && !isSlashCommand(frame.text) ? await ctx.peers.mentions(runner.id, frame.text).catch(() => []) : []
      const options = mentions.length > 0 ? { mentions } : undefined
      if (!frame.attachmentIds?.length) {
        runner.sendMessage(frame.text, undefined, options)
        return
      }
      const resolved = attachmentStore.resolve(runner.id, frame.attachmentIds)
      if (!resolved.ok) {
        throw new Error(`unknown attachment(s): ${resolved.missing.join(', ')}`)
      }
      runner.sendMessage(frame.text, resolved.attachments, options)
      return
    }
    case 'permission_decision': {
      if (frame.behavior === 'allow') {
        runner.resolvePermission(frame.requestId, {
          behavior: 'allow',
          updatedInput: frame.updatedInput,
        })
      } else {
        runner.resolvePermission(frame.requestId, {
          behavior: 'deny',
          message: frame.message,
          interrupt: frame.interrupt,
        })
      }
      return
    }
    case 'interrupt': {
      await runner.interrupt()
      return
    }
    case 'clear_context': {
      if (!runner.clearContext) {
        throw new Error(`the ${runner.info().engine ?? 'claude'} engine cannot clear a conversation`)
      }
      await runner.clearContext()
      return
    }
    case 'set_permission_mode': {
      if (frame.mode === 'bypassPermissions' && ctx.options.disableBypassPermissions) {
        throw new Error('bypassPermissions is disabled on this server (disableBypassPermissions)')
      }
      await runner.setPermissionMode(frame.mode)
      return
    }
    case 'set_model': {
      await runner.setModel(frame.model)
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
      if (!runner.queueLocalCommand) {
        throw new Error(`the ${runner.info().engine ?? 'claude'} engine cannot take shell output`)
      }
      const { shell, source } = await shells.spawn({ runner, command: frame.command, owner: 'user' })
      try {
        runner.queueLocalCommand(source)
      } catch (error) {
        // queueLocalCommand throws before it pushes, so without this the shell would run with no transcript row.
        shells.kill(runner.id, shell.id)
        throw error
      }
      return
    }
    case 'shell_attach': {
      await attachShell(permittedShells(ctx, runner, access), client, runner.id, frame.shellId, { cols: frame.cols, rows: frame.rows })
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

function permittedShells(ctx: ServerContext, runner: Runner, access: AttachAccess): ShellRegistry {
  if (ctx.shells === null || !shellPermitted(ctx.shells, runner, access.operator)) {
    throw new Error(SHELL_REFUSAL)
  }
  return ctx.shells
}

async function attachShell(shells: ShellRegistry, client: Client, sessionId: string, shellId: string, size: ShellSize): Promise<void> {
  shells.resize(sessionId, shellId, size)
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
