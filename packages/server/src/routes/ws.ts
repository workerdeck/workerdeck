import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import type { Runner } from '@workerdeck/core'
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'

export function attachClient(ctx: ServerContext, ws: WebSocket, runner: Runner, req: IncomingMessage): void {
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

  send({
    type: 'attached',
    protocolVersion: PROTOCOL_VERSION,
    session: ctx.projects.withProject(runner.info()),
    replayingFrom: afterSeq,
  })
  const unsubscribe = runner.subscribe((event) => send({ type: 'event', event }), afterSeq, {
    coalesceReplay: true,
    truncateResults,
    imageRefs,
  })
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
      const resolved = attachmentStore.resolve(runner.id, frame.attachmentIds)
      if (!resolved.ok) {
        throw new Error(`unknown attachment(s): ${resolved.missing.join(', ')}`)
      }
      runner.sendMessage(frame.text, resolved.attachments)
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
    case 'close': {
      runner.close('client')
      return
    }
    default: {
      throw new Error(`unknown command: ${(frame as { type?: string }).type}`)
    }
  }
}
