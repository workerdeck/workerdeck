/** The session WebSocket: attach (replay + live), and the client command
 * surface. One live attach per client socket; the bridge registration is what
 * lets this client execute bridged tool calls in its own sandbox. */
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type { Runner } from '@workerdeck/core'
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'

export function attachClient(
  ctx: ServerContext,
  ws: WebSocket,
  runner: Runner,
  req: IncomingMessage,
): void {
  const { bridge, parking } = ctx
  const url = new URL(req.url ?? '/', 'http://internal')
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0
  // Opt-in, from the query string, because only the attaching *renderer* knows
  // whether it can fetch the rest (see `Runner.subscribe`). A gateway that
  // truncated for everyone would hand an older client a head with no marker.
  const truncateResults = url.searchParams.get('truncateResults') === '1'
  // Its own flag rather than a widening of `truncateResults`, and the reason is
  // the family's no-bump argument itself: it rests on "a client that never asked
  // cannot receive one" holding *by construction*. A flag whose meaning grew
  // after it shipped is exactly the fact a later reader cannot recover, and a
  // caller that asked for text heads never asked to have its pixels swapped for
  // addresses it has no code to fetch.
  const imageRefs = url.searchParams.get('imageRefs') === '1'

  const send = (frame: ServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }

  send({
    type: 'attached',
    protocolVersion: PROTOCOL_VERSION,
    // The attach snapshot is the session-level source (no event carries it),
    // so project identity is stamped here like everywhere a SessionInfo ships.
    session: ctx.projects.withProject(runner.info()),
    replayingFrom: afterSeq,
  })
  // `coalesceReplay` is opt-in and this is the one caller: a client's reducer
  // is last-write-wins for the readings it drops, so all it ever sees is the
  // final value — whereas the in-process subscribers (parking above all) read
  // those same events as *transitions* and must keep every one. Without it a
  // long session replays every per-turn usage poll, and the client renders
  // each: the meters visibly count up through the session's whole history on
  // every attach.
  const unsubscribe = runner.subscribe((event) => send({ type: 'event', event }), afterSeq, {
    coalesceReplay: true,
    truncateResults,
    imageRefs,
  })
  // Register for bridged tool calls: this client can be asked to execute them
  // in its own sandbox (see BridgeHub).
  const detachBridge = bridge.attach(runner.id, send)

  ws.on('message', (data: Buffer) => {
    let frame: ClientFrame
    try {
      frame = JSON.parse(data.toString('utf8')) as ClientFrame
    } catch {
      send({ type: 'protocol_error', message: 'invalid JSON frame' })
      return
    }
    handleCommand(ctx, frame, runner).catch((error: unknown) => {
      send({
        type: 'protocol_error',
        message: error instanceof Error ? error.message : 'command failed',
      })
    })
  })
  ws.on('close', () => {
    unsubscribe()
    detachBridge()
    // Nobody watching any more: a session waiting on a deferred execution can
    // give its runner back (after a grace period, so a reconnect costs nothing).
    parking.onDetach(runner.id)
  })
}

async function handleCommand(ctx: ServerContext, frame: ClientFrame, runner: Runner): Promise<void> {
  const { attachmentStore, bridge } = ctx
  switch (frame.type) {
    case 'user_message': {
      if (!frame.attachmentIds?.length) {
        runner.sendMessage(frame.text)
        return
      }
      // The bytes live server-side; this is where a reference becomes content.
      // A missing id throws rather than sending a message that lost its picture.
      const resolved = attachmentStore.resolve(runner.id, frame.attachmentIds)
      if (!resolved.ok) {
        throw new Error(`unknown attachment(s): ${resolved.missing.join(', ')}`)
      }
      runner.sendMessage(frame.text, resolved.attachments)
      return
    }
    case 'permission_decision':
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
    case 'interrupt':
      await runner.interrupt()
      return
    case 'clear_context':
      // Optional on `Runner`, like every member added after it became public
      // API. An engine that declines it declines the command with it, which is
      // exactly what `EngineCapabilities.clearContext` told the client to
      // expect — so the error names the engine rather than being a bare throw.
      // It reaches the client as a `protocol_error` frame like every other
      // command failure here; there is no HTTP route for this.
      if (!runner.clearContext) {
        throw new Error(
          `the ${runner.info().engine ?? 'claude'} engine cannot clear a conversation`,
        )
      }
      await runner.clearContext()
      return
    case 'set_permission_mode':
      if (frame.mode === 'bypassPermissions' && ctx.options.disableBypassPermissions) {
        throw new Error('bypassPermissions is disabled on this server (disableBypassPermissions)')
      }
      await runner.setPermissionMode(frame.mode)
      return
    case 'set_model':
      await runner.setModel(frame.model)
      return
    case 'tool_call_result':
      // Untrusted client input by contract — fine for the user's own data,
      // never a source for server-authoritative state. Unknown or already
      // settled ids are ignored rather than erroring: a late answer racing a
      // timeout is expected, not a client bug.
      bridge.resolve(runner.id, frame.executionId, { output: frame.output, logs: frame.logs })
      return
    case 'tool_call_error':
      bridge.resolve(runner.id, frame.executionId, {
        reason: frame.reason,
        error: frame.error,
        logs: frame.logs,
      })
      return
    case 'close':
      runner.close('client')
      return
    default:
      throw new Error(`unknown command: ${(frame as { type?: string }).type}`)
  }
}
