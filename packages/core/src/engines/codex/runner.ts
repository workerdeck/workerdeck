import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENGINE_CAPABILITIES,
  type ContentBlock,
  type CreateSessionRequest,
  type PermissionMode,
  type PermissionRequest,
  type SessionEvent,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
} from '@workerdeck/protocol'
import { attachmentKind, attachmentRef, normalizeMediaType, type AttachmentInput } from '../../attachments.ts'
import type { PermissionDecision, Runner, SessionEventListener } from '../../runner-interface.ts'
import type {
  CodexFactory,
  CodexLike,
  CodexThreadItem,
  CodexThreadOptions,
  CodexUnknownItem,
  CodexUsage,
  CodexUserInput,
} from './types.ts'

/**
 * Our permission modes as codex sandbox modes, always with `approvalPolicy:
 * 'never'` — exec mode has no ask channel (stdin closes after the prompt), so
 * any other policy would stall or fail the turn.
 *
 * - `default` → read-only: "would have asked before acting" degrades honestly
 *   to "cannot act" — reads and analysis run, writes are refused by the OS
 *   sandbox. Keeps `default` universally offerable.
 * - `acceptEdits` → workspace-write: precisely "edits in the workspace are
 *   pre-approved". Network stays codex's own default for this sandbox (off).
 * - `bypassPermissions` → danger-full-access.
 */
const SANDBOX_BY_MODE: Partial<Record<PermissionMode, CodexThreadOptions['sandboxMode']>> = {
  default: 'read-only',
  acceptEdits: 'workspace-write',
  bypassPermissions: 'danger-full-access',
}

export type CodexRunnerConfig = CreateSessionRequest & {
  /** The injectable Codex constructor. The codex adapter passes the real SDK's;
   * unit tests pass a scripted one. Required — this class never imports the
   * SDK itself (it is an optional peer, resolved by the adapter). */
  codexFn: CodexFactory
  /** Base environment for the codex child. Defaults to process.env. Passed to
   * the SDK **complete** — CodexOptions.env replaces, never merges. */
  env?: Record<string, string | undefined>
  /** CODEX_HOME pin from the profile (auth, config.toml, thread storage).
   * Unset = the binary's own ~/.codex. */
  codexHome?: string
  /** Explicit binary path override (tests, exotic installs). */
  codexPathOverride?: string
}

/** One queued user message: the input for exactly one exec turn. */
type QueuedTurn = { input: string | CodexUserInput[] }

/**
 * The Codex engine: one session = one codex thread, one turn = one
 * `codex exec --experimental-json` spawn (the SDK's process model). Follows
 * `SessionRunner`'s event-log/seq/status discipline with `AiSdkRunner`'s
 * turn-chain (one turn at a time; sendMessage queues).
 *
 * Because every turn is a fresh spawn, between-turn mutability is free:
 * `setModel` / `setPermissionMode` change what the next spawn gets (both
 * refuse mid-turn — the running child's settings are fixed). There is no
 * `system_init` (that event is the Claude CLI handshake's): clients seed from
 * the attach snapshot, and `sdkSessionId` is set from `thread.started`.
 *
 * Interactive approvals are structurally impossible in exec mode — see
 * ENGINE_CAPABILITIES.codex — so the pending-approval surface is empty by
 * construction.
 */
export class CodexRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: CodexRunnerConfig
  #codex: CodexLike
  #events: SessionEvent[] = []
  #listeners = new Set<SessionEventListener>()
  #seq = 0
  #status: SessionStatus = 'starting'
  #sdkSessionId: string | undefined
  #model: string | undefined
  #permissionMode: PermissionMode
  #reasoningEffort: string | undefined
  #queue: QueuedTurn[] = []
  #turnChain: Promise<void> = Promise.resolve()
  #abort: AbortController | undefined
  #numTurns = 0
  #totalCostUsd: number | undefined
  #lastActivityAt: number | undefined
  #started = false
  #closed = false
  /** Session temp dir for image attachments (codex takes host paths). */
  #imageDir: string | undefined

  constructor(config: CodexRunnerConfig, id: string = randomUUID()) {
    const mode = config.permissionMode ?? 'default'
    if (!ENGINE_CAPABILITIES.codex.permissionModes.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the codex engine`)
    }
    if (config.forkSession) {
      throw new Error('the codex engine cannot fork a resumed thread')
    }
    this.#config = config
    this.#permissionMode = mode
    this.#model = config.model
    this.#reasoningEffort = config.reasoningEffort
    this.#sdkSessionId = config.resume
    this.#codex = config.codexFn({
      codexPathOverride: config.codexPathOverride,
      env: this.#childEnv(),
    })
    this.id = id
    this.createdAt = Date.now()
  }

  /** The complete child environment. CodexOptions.env replaces process.env
   * wholesale (§types), so this must carry everything a shell would — plus the
   * profile's CODEX_HOME pin, which must win over operator env. */
  #childEnv(): Record<string, string> {
    const base = this.#config.env ?? process.env
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) env[key] = value
    }
    if (this.#config.codexHome) env.CODEX_HOME = this.#config.codexHome
    return env
  }

  get status(): SessionStatus {
    return this.#status
  }

  get sdkSessionId(): string | undefined {
    return this.#sdkSessionId
  }

  get lastSeq(): number {
    return this.#seq
  }

  get pendingApprovals(): PermissionRequest[] {
    return []
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.#config.cwd,
      profile: this.#config.profile,
      engine: 'codex',
      capabilities: ENGINE_CAPABILITIES.codex,
      model: this.#model,
      permissionMode: this.#permissionMode,
      // Nothing gates the switch at spawn time — every mode maps to a sandbox
      // flag on the next turn's child. Mode changes still apply next turn only.
      canBypassPermissions: true,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      meta: this.#config.meta,
      title: this.#title(),
      totalCostUsd: this.#totalCostUsd,
      numTurns: this.#numTurns || undefined,
      lastActivityAt: this.#lastActivityAt,
    }
  }

  #title(): string | undefined {
    const metaTitle = this.#config.meta?.title
    if (typeof metaTitle === 'string' && metaTitle.length > 0) return metaTitle
    const prompt = this.#config.prompt
    if (!prompt) return undefined
    return prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt
  }

  start(): Promise<void> {
    if (this.#started) return this.#turnChain
    this.#started = true
    this.#setStatus('idle')
    if (this.#config.prompt) this.sendMessage(this.#config.prompt)
    return this.#turnChain
  }

  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void {
    if (this.#closed) throw new Error('session is closed')
    const input = attachments?.length ? this.#buildInput(text, attachments) : text
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      attachments: attachments?.length ? attachments.map(attachmentRef) : undefined,
      uuid: randomUUID(),
    })
    this.#queue.push({ input })
    this.#scheduleTurn()
  }

  /**
   * Codex input for a message with attachments. Images travel as host file
   * paths (`--image`), so the bytes land in a session temp dir first; text
   * files inline into the prompt in the same named envelope the other engines
   * use. PDF has no representation — the gateway's 415 normally refuses it
   * before this, so a throw here is a defensive backstop, not a user surface.
   */
  #buildInput(text: string, attachments: readonly AttachmentInput[]): CodexUserInput[] {
    const parts: CodexUserInput[] = []
    for (const attachment of attachments) {
      const mediaType = normalizeMediaType(attachment.mediaType)
      switch (attachmentKind(mediaType)) {
        case 'image': {
          this.#imageDir ??= join(tmpdir(), `workerdeck-codex-${this.id}`)
          mkdirSync(this.#imageDir, { recursive: true })
          // The id leads so two uploads named "photo.jpg" never collide; the
          // name survives only as its extension (all the path is used for).
          const ext = mediaType.split('/')[1] ?? 'bin'
          const path = join(this.#imageDir, `${attachment.id}.${ext}`)
          writeFileSync(path, Buffer.from(attachment.data, 'base64'))
          parts.push({ type: 'local_image', path })
          break
        }
        case 'text':
          parts.push({
            type: 'text',
            text:
              `<attachment name="${attachment.name}" type="${mediaType}">\n` +
              `${Buffer.from(attachment.data, 'base64').toString('utf8')}\n</attachment>`,
          })
          break
        default:
          throw new Error(`unsupported attachment media type for the codex engine: ${attachment.mediaType}`)
      }
    }
    if (text) parts.push({ type: 'text', text })
    return parts
  }

  resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false
  }

  async interrupt(): Promise<void> {
    // Kills the child via TurnOptions.signal; the turn ends as
    // error_during_execution ['interrupted'] when the stream throws.
    this.#abort?.abort()
    await this.#turnChain
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!ENGINE_CAPABILITIES.codex.permissionModes.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the codex engine`)
    }
    if (this.#abort) {
      throw new Error("cannot change the permission mode mid-turn (the running child's sandbox is fixed)")
    }
    this.#permissionMode = mode
    this.#emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    if (this.#abort) {
      throw new Error("cannot change the model mid-turn (the running child's model is fixed)")
    }
    this.#model = model
    this.#emit({ type: 'model_changed', model })
  }

  fail(message: string): void {
    if (this.#closed) return
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.#closed) return
    this.#closed = true
    this.#abort?.abort()
    this.#queue.length = 0
    if (this.#imageDir) {
      try {
        rmSync(this.#imageDir, { recursive: true, force: true })
      } catch {
        // Temp-dir cleanup must never break teardown.
      }
    }
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
  }

  subscribe(listener: SessionEventListener, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) listener(event)
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #scheduleTurn(): void {
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  #threadOptions(): CodexThreadOptions {
    return {
      model: this.#model,
      sandboxMode: SANDBOX_BY_MODE[this.#permissionMode],
      // The gateway's cwd contract carries no git requirement (Claude sessions
      // have none), so the repo check is always skipped.
      workingDirectory: this.#config.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      ...(this.#reasoningEffort ? { modelReasoningEffort: this.#reasoningEffort } : {}),
    }
  }

  async #runTurn(): Promise<void> {
    if (this.#closed) return
    const turn = this.#queue.shift()
    if (!turn) return
    this.#setStatus('running')
    const abort = new AbortController()
    this.#abort = abort
    const startedAt = Date.now()
    /** Text growth already streamed per item id, for delta synthesis. */
    const streamed = new Map<string, string>()
    /** tool_use blocks already emitted, so completions pair with them. */
    const toolUseEmitted = new Set<string>()
    let finalText: string | undefined
    let usage: CodexUsage | undefined
    let failure: string | undefined
    let sawTerminal = false
    try {
      const thread = this.#sdkSessionId
        ? this.#codex.resumeThread(this.#sdkSessionId, this.#threadOptions())
        : this.#codex.startThread(this.#threadOptions())
      const { events } = await thread.runStreamed(turn.input, { signal: abort.signal })
      for await (const event of events) {
        if (this.#closed) break
        switch (event.type) {
          case 'thread.started':
            this.#sdkSessionId = event.thread_id
            break
          case 'turn.started':
            break
          case 'item.started':
          case 'item.updated':
            this.#handleItemProgress(event.item, streamed, toolUseEmitted)
            break
          case 'item.completed': {
            const text = this.#handleItemCompleted(event.item, streamed, toolUseEmitted)
            if (text !== undefined) finalText = text
            break
          }
          case 'turn.completed':
            usage = event.usage
            sawTerminal = true
            break
          case 'turn.failed':
            failure = event.error.message
            sawTerminal = true
            break
          case 'error':
            // Retry noise mostly (reconnect attempts); keep the last message so
            // a stream that dies without a turn.* terminal still explains itself.
            failure ??= event.message
            break
          default:
            break
        }
      }
      if (this.#closed) return
      if (sawTerminal && usage) {
        this.#finishTurn('success', startedAt, finalText, usage)
      } else {
        this.#finishTurn('failure', startedAt, undefined, undefined, [
          failure ?? 'codex exec ended without a turn result',
        ])
      }
    } catch (error) {
      if (this.#closed) return
      // A failed *turn* is not a failed *session*: the thread persists and the
      // next message spawns a fresh child. Only a spawn that cannot start at
      // all would justify session_error, and that surfaces here identically —
      // the distinction isn't observable from the stream, so every failure is
      // a turn failure and the session stays usable.
      const message = error instanceof Error ? error.message : String(error)
      this.#finishTurn('failure', startedAt, undefined, undefined, [
        abort.signal.aborted ? 'interrupted' : message,
      ])
    } finally {
      if (this.#abort === abort) this.#abort = undefined
    }
  }

  /** Delta synthesis for the two text-bearing items: emitted as suffix growth
   * vs the last seen text, at whatever cadence the JSONL flushes — coarse
   * (`streaming: 'item'`), fine for a transcript, not a typing cursor. */
  #handleItemProgress(
    item: CodexThreadItem,
    streamed: Map<string, string>,
    toolUseEmitted: Set<string>,
  ): void {
    if (item.type === 'agent_message' || item.type === 'reasoning') {
      if (this.#config.includePartialMessages === false) return
      const previous = streamed.get(item.id) ?? ''
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text.startsWith(previous) || text.length === previous.length) return
      const delta = text.slice(previous.length)
      streamed.set(item.id, text)
      this.#emit({
        type: 'stream_delta',
        event: {
          type: 'content_block_delta',
          delta:
            item.type === 'reasoning'
              ? { type: 'thinking_delta', thinking: delta }
              : { type: 'text_delta', text: delta },
        },
        parentToolUseId: null,
        uuid: randomUUID(),
      })
      return
    }
    if (item.type === 'command_execution' && !toolUseEmitted.has(item.id)) {
      toolUseEmitted.add(item.id)
      this.#emitToolUse(item.id, 'CodexCommand', { command: item.command })
      return
    }
    if (item.type === 'mcp_tool_call' && !toolUseEmitted.has(item.id)) {
      toolUseEmitted.add(item.id)
      this.#emitToolUse(item.id, `mcp__${item.server}__${item.tool}`, item.arguments)
      return
    }
    if (item.type === 'todo_list') {
      this.#emit({ type: 'sdk_event', payload: { type: 'codex.todo_list', id: item.id, items: item.items } })
    }
  }

  /** Fold a completed item into the transcript. Returns the turn's final text
   * when the item carries it (agent_message). */
  #handleItemCompleted(
    item: CodexThreadItem,
    streamed: Map<string, string>,
    toolUseEmitted: Set<string>,
  ): string | undefined {
    switch (item.type) {
      case 'agent_message': {
        streamed.delete(item.id)
        const text = typeof item.text === 'string' ? item.text : ''
        this.#emitAssistant(item.id, [{ type: 'text', text }])
        return text
      }
      case 'reasoning': {
        streamed.delete(item.id)
        const thinking = typeof item.text === 'string' ? item.text : ''
        // Its own assistant_message, preceding the text — AiSdkRunner's block order.
        if (thinking) this.#emitAssistant(item.id, [{ type: 'thinking', thinking }])
        return undefined
      }
      case 'command_execution': {
        if (!toolUseEmitted.has(item.id)) {
          toolUseEmitted.add(item.id)
          this.#emitToolUse(item.id, 'CodexCommand', { command: item.command })
        }
        const failed = item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0)
        const output =
          item.aggregated_output +
          (item.exit_code !== undefined && item.exit_code !== 0
            ? `\n(exit code ${item.exit_code})`
            : '')
        this.#emitToolResult(item.id, output, failed)
        return undefined
      }
      case 'file_change': {
        // Post-hoc by design: the patch already succeeded or failed — there is
        // no proposal stage in exec mode.
        this.#emitToolUse(item.id, 'CodexFileChange', { changes: item.changes })
        this.#emitToolResult(
          item.id,
          item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n') || item.status,
          item.status === 'failed',
        )
        return undefined
      }
      case 'mcp_tool_call': {
        if (!toolUseEmitted.has(item.id)) {
          toolUseEmitted.add(item.id)
          this.#emitToolUse(item.id, `mcp__${item.server}__${item.tool}`, item.arguments)
        }
        const isError = item.error !== undefined || item.status === 'failed'
        this.#emitToolResult(
          item.id,
          item.error?.message ?? (item.result === undefined ? '' : JSON.stringify(item.result)),
          isError,
        )
        return undefined
      }
      case 'web_search':
        this.#emitToolUse(item.id, 'CodexWebSearch', { query: item.query })
        this.#emitToolResult(item.id, '', false)
        return undefined
      case 'todo_list':
        this.#emit({ type: 'sdk_event', payload: { type: 'codex.todo_list', id: item.id, items: item.items } })
        return undefined
      case 'error':
        this.#emit({ type: 'sdk_event', payload: { type: 'codex.error', message: item.message } })
        return undefined
      default: {
        const unknown = item as CodexUnknownItem
        this.#emit({ type: 'sdk_event', payload: { type: `codex.${unknown.type}`, item: unknown } })
        return undefined
      }
    }
  }

  #emitAssistant(uuid: string, content: ContentBlock[]): void {
    this.#emit({
      type: 'assistant_message',
      message: { role: 'assistant', content, model: this.#model },
      parentToolUseId: null,
      uuid,
    })
  }

  #emitToolUse(id: string, name: string, input: unknown): void {
    this.#emit({
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input }],
        model: this.#model,
      },
      parentToolUseId: null,
      uuid: `${id}-use`,
    })
  }

  /** The AiSdkRunner tool_result shape, so the reducer and both UIs render
   * their existing cards unchanged. */
  #emitToolResult(toolUseId: string, content: string, isError: boolean): void {
    this.#emit({
      type: 'user_message',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError || undefined },
        ],
      },
      parentToolUseId: null,
      synthetic: true,
      uuid: `${toolUseId}-result`,
    })
  }

  /**
   * Per-turn usage under the Anthropic accounting convention the whole stack
   * assumes (queue budgets sum input+output+cache_creation+cache_read):
   * `input_tokens` excludes the cached share (OpenAI's includes it — asserted
   * in smoke:codex, see the PRD's open question 1), reasoning tokens are
   * billed output. `totalCostUsd: 0` = unknown, the AiSdkRunner precedent.
   */
  #finishTurn(
    kind: 'success' | 'failure',
    startedAt: number,
    result?: string,
    usage?: CodexUsage,
    errors?: string[],
  ): void {
    this.#numTurns += 1
    this.#totalCostUsd = 0
    this.#emit({
      type: 'turn_result',
      subtype: kind === 'success' ? 'success' : 'error_during_execution',
      isError: kind !== 'success',
      durationMs: Date.now() - startedAt,
      numTurns: this.#numTurns,
      totalCostUsd: 0,
      result: kind === 'success' ? (result ?? '') : undefined,
      errors,
      usage: usage
        ? {
            input_tokens: Math.max(0, usage.input_tokens - usage.cached_input_tokens),
            output_tokens: usage.output_tokens + usage.reasoning_output_tokens,
            cache_creation_input_tokens: usage.cache_write_input_tokens,
            cache_read_input_tokens: usage.cached_input_tokens,
          }
        : undefined,
    })
    this.#setStatus('idle')
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#status === status) return
    if (this.#status === 'closed' || this.#status === 'failed') return
    this.#status = status
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#lastActivityAt = event.ts
    this.#events.push(event)
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Listener errors must not break the runner loop.
      }
    }
  }
}
