import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { PROTOCOL_VERSION } from '@workerdeck/protocol'
import {
  rateLimitWindows,
  useAttachments,
  useClaudeSession,
  useHostFileSearch,
  useToolCallHost,
  type ProducedFileRef,
} from '@workerdeck/react'
import {
  ChartPie,
  FolderTree,
  Gauge,
  Info,
  MoreHorizontal,
  Plug,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.tsx'
import { Composer, skillPrompt, type ComposerHandle } from './Composer.tsx'
import { ContextDialog } from './ContextDialog.tsx'
import { HostFilesDialog } from './HostFilesDialog.tsx'
import { McpDialog } from './McpDialog.tsx'
import { SkillsDialog } from './SkillsDialog.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionModeSelect } from './PermissionModeSelect.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
import { SessionInfoDialog } from './SessionInfoDialog.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'
import { UsageDialog } from './UsageDialog.tsx'

export interface SessionPanelProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  /** Optional slot rendered at the top, above the status bar. */
  header?: ReactNode
  className?: string
}

/** The panels the session surface can raise. One at a time, by identity: a bag
 * of booleans would let two open at once. */
type Panel = 'info' | 'context' | 'usage' | 'mcp' | 'files' | 'skills'

/**
 * The all-in-one embeddable session surface: status bar, streaming transcript,
 * permission prompts, composer. Attaches via useClaudeSession; remount (key) to switch
 * sessions.
 *
 * Every affordance is gated on the session's **capability record** rather than on
 * the engine name — an absent capability hides the control instead of offering
 * one that can only fail.
 */
export function SessionPanel({ client, sessionId, header, className }: SessionPanelProps) {
  // Rejected commands (the CLI refusing a permission-mode switch, say) render INSIDE
  // the panel rather than through `toast`. The panel does not mount a `Toaster`, and
  // an embedder that doesn't either would drop the only signal that a command failed
  // — the select would just "not stick". An error channel a host can lose by omission
  // is not an error channel.
  const [protocolError, setProtocolError] = useState<string | undefined>(undefined)
  const [panel, setPanel] = useState<Panel | undefined>()
  const {
    state,
    connection,
    protocolMismatch,
    models,
    effectiveModel,
    handle,
    send,
    approve,
    deny,
    interrupt,
    setModel,
    setPermissionMode,
    reconnectNow,
  } = useClaudeSession(client, sessionId, { onProtocolError: setProtocolError })
  // Callers are told to remount on a session switch, but a changed prop must not leave
  // the previous session's failure on screen.
  useEffect(() => setProtocolError(undefined), [sessionId])
  // A tab that was in the background has been sitting out the reconnect backoff;
  // coming back to it is exactly when waiting the rest of it out is wrong.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconnectNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reconnectNow])
  // Host server-bridged tool calls (provider-engine sessions) in this tab, on the
  // SAME handle the panel attached with — the bridge asks the first attached
  // client. Free for Claude sessions: the guest loads lazily on the first call,
  // which for them never comes.
  useToolCallHost(handle)
  const capabilities = state.capabilities
  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  const ended = state.status === 'failed' || state.status === 'closed'
  const attachments = useAttachments(client, sessionId, {
    capabilities,
    engine: state.engine,
  })
  // Rooted at the session's cwd, which arrives with the snapshot — so `@` is
  // inert for the moment before it does, and stays inert on a gateway that
  // serves no host files.
  const hostFiles = useHostFileSearch(client, state.cwd)
  const windows = useMemo(() => rateLimitWindows(state), [state])
  // Reads a picture the engine left on the host (codex's `image_gen` reports a
  // path, never bytes). Stable and memoized per path: transcript rows re-render
  // on every delta, and a fresh function would re-fetch each time.
  const hostImage = useHostImage(client, sessionId, state.producedFiles)
  const composerRef = useRef<ComposerHandle>(null)

  // "/model" is handled panel-side (see handleSend) — surface it in the autocomplete
  // even though the CLI's command list doesn't include it.
  const commands = useMemo(() => {
    if (!state.commands) return undefined
    if (state.commands.some((c) => c.name === 'model')) return state.commands
    return [
      { name: 'model', description: 'Switch the model for this session', argumentHint: '<model>' },
      ...state.commands,
    ]
  }, [state.commands])

  // Two things are answered here rather than sent, because sending them would
  // spend a turn on a model reading the words back.
  const handleSend = (text: string, attachmentIds: string[]) => {
    if (attachmentIds.length === 0) {
      // "/model <id>" switches the model directly instead of going to the CLI.
      const modelCommand = /^\/model\s+(\S+)$/.exec(text)
      if (modelCommand) {
        setModel(modelCommand[1])
        return
      }
      // The CLI's own `/mcp` is an interactive picker, not a prompt. Only where
      // the capability exists: elsewhere it is ordinary message text, like any
      // other slash command on an engine without them.
      if (capabilities.mcpStatus && text.trim() === '/mcp') {
        setPanel('mcp')
        return
      }
    }
    send(text, attachmentIds)
  }

  return (
    <div
      data-slot='session-panel'
      className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}>
      {header}
      <StatusBar
        state={state}
        connection={connection}
        onOpenStatus={() => setPanel('info')}
        onOpenContext={() => setPanel('context')}
        onOpenUsage={() => setPanel('usage')}
        actions={
          // Everything the panel can open, in one place — and each one is also
          // reachable by clicking the thing on the bar that summarises it.
          // Entries the capability record forswears are absent, not
          // present-and-empty.
          <Menu>
            <MenuTrigger
              render={
                <Button variant='ghost' size='icon-sm' aria-label='Session actions'>
                  <MoreHorizontal className='size-4' />
                </Button>
              }
            />
            <MenuContent>
              {capabilities.contextUsage ? (
                <MenuItem onClick={() => setPanel('context')}>
                  <ChartPie className='size-3.5 text-fg-3' /> Context
                </MenuItem>
              ) : null}
              {capabilities.rateLimits ? (
                <MenuItem onClick={() => setPanel('usage')}>
                  <Gauge className='size-3.5 text-fg-3' /> Usage
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => setPanel('info')}>
                <Info className='size-3.5 text-fg-3' /> Session info
              </MenuItem>
              {capabilities.mcpStatus ? (
                <MenuItem onClick={() => setPanel('mcp')}>
                  <Plug className='size-3.5 text-fg-3' /> MCP servers
                </MenuItem>
              ) : null}
              {/* On the capability alone, like MCP's entry. Codex answers
                  `skills/list` only over a live child, so before the first turn
                  there is no list yet — but hiding the entry until then made the
                  dialog's own explanation of that unreachable, which read as the
                  feature being missing. The empty state says it instead. */}
              {capabilities.skillsList ? (
                <MenuItem onClick={() => setPanel('skills')}>
                  <Sparkles className='size-3.5 text-fg-3' /> Skills
                </MenuItem>
              ) : null}
              {hostFiles.available ? (
                <MenuItem onClick={() => setPanel('files')}>
                  <FolderTree className='size-3.5 text-fg-3' /> Project files
                </MenuItem>
              ) : null}
            </MenuContent>
          </Menu>
        }
      />
      {protocolMismatch !== undefined ? (
        <Notice level='warning'>
          Server speaks protocol v{protocolMismatch}, this build renders v{PROTOCOL_VERSION}. Some
          events may not render.
        </Notice>
      ) : null}
      {protocolError ? (
        <Notice level='error' onDismiss={() => setProtocolError(undefined)}>
          {protocolError}
        </Notice>
      ) : null}
      <Transcript
        state={state}
        fileUrl={sessionId ? (path) => client.sessionFileUrl(sessionId, path) : undefined}
        attachmentUrl={sessionId ? (id) => client.attachmentUrl(sessionId, id) : undefined}
        canBrowseFiles={hostFiles.available}
        hostImage={hostImage}
      />
      {/* An engine with no approval channel never raises these, but a stale
          pending request from a replayed log would still render — the record is
          the authority on whether an approval UI means anything here. */}
      {capabilities.interactiveApprovals && state.pendingApprovals.length > 0 ? (
        <div className='px-3 pb-2'>
          <div className='mx-auto flex w-full max-w-3xl flex-col gap-2'>
            {state.pendingApprovals.map((request) =>
              request.toolName === 'AskUserQuestion' &&
              parseUserQuestions(request.input).length > 0 ? (
                <QuestionPrompt
                  key={request.id}
                  request={request}
                  onAnswer={approve}
                  onDismiss={(id) => deny(id, 'Question dismissed by user')}
                />
              ) : (
                <PermissionPrompt
                  key={request.id}
                  request={request}
                  onApprove={approve}
                  onDeny={deny}
                />
              ),
            )}
          </div>
        </div>
      ) : null}
      <Composer
        ref={composerRef}
        onSend={handleSend}
        onInterrupt={interrupt}
        busy={busy}
        disabled={ended || !sessionId}
        commands={capabilities.slashCommands ? commands : undefined}
        skills={capabilities.skillsList ? state.skills : undefined}
        attachments={attachments}
        onSearchFiles={
          hostFiles.available
            ? (query, options) => hostFiles.search(query, { ...options, limit: 8 })
            : undefined
        }
        toolbar={
          <>
            {/* Codex reports no `capabilities` event, so its models arrive from
                the profile catalog instead — without that fallback its picker
                would be permanently empty and the session unswitchable. */}
            {models.length ? (
              <ModelSelect
                models={models}
                model={effectiveModel}
                onModelChange={setModel}
                disabled={ended}
              />
            ) : null}
            {state.permissionMode ? (
              <PermissionModeSelect
                mode={state.permissionMode}
                onModeChange={setPermissionMode}
                // Only what this engine implements — the rest would come back as
                // a protocol_error.
                modes={capabilities.permissionModes}
                canBypass={state.session?.canBypassPermissions}
                disabled={ended}
              />
            ) : null}
          </>
        }
      />

      <SessionInfoDialog
        state={state}
        client={client}
        sessionId={sessionId}
        open={panel === 'info'}
        onOpenChange={(next) => setPanel(next ? 'info' : undefined)}
      />
      <ContextDialog
        usage={state.contextUsage}
        open={panel === 'context'}
        onOpenChange={(next) => setPanel(next ? 'context' : undefined)}
      />
      <UsageDialog
        rateLimits={windows}
        subscriptionType={state.subscriptionType}
        engine={state.engine ?? 'claude'}
        totalCostUsd={state.totalCostUsd}
        updatedAt={state.rateLimitsUpdatedAt}
        open={panel === 'usage'}
        onOpenChange={(next) => setPanel(next ? 'usage' : undefined)}
      />
      <McpDialog
        client={client}
        sessionId={sessionId}
        open={panel === 'mcp'}
        onOpenChange={(next) => setPanel(next ? 'mcp' : undefined)}
      />
      <SkillsDialog
        skills={state.skills}
        open={panel === 'skills'}
        onOpenChange={(next) => setPanel(next ? 'skills' : undefined)}
        // Drafts into the composer; the operator sends it. There is no engine
        // call that runs a skill, so there is nothing else this button could do.
        onUse={(skill) => composerRef.current?.insertText(skillPrompt(skill))}
      />
      <HostFilesDialog
        client={client}
        cwd={state.cwd}
        open={panel === 'files'}
        onOpenChange={(next) => setPanel(next ? 'files' : undefined)}
      />
    </div>
  )
}

/**
 * Turns a host path a tool card is holding into something an `<img>` can show.
 *
 * Two sources, tried in that order and for a reason:
 *
 * 1. **The session's produced files.** If this session's own runner announced
 *    writing that path (`file_produced`), the gateway will serve it from
 *    `/sessions/:id/produced/:fileId` — no host-file roots to declare, no byte
 *    cap to raise. This is the path codex's generated images take, and it is
 *    why they now render out of the box.
 * 2. **`/fs/read`.** For a path nothing produced — a picture the model looked
 *    at, an image already in the tree — where the operator's declared roots are
 *    the right gate and the answer is legitimately "no" outside them.
 *
 * The cache is what makes this usable from a transcript row: rows re-render on
 * every streamed delta, and an uncached resolver would re-fetch the picture each
 * time. A refusal is cached too, so it costs one request rather than one per
 * render.
 *
 * Keyed by `fileId`-or-path so that a path which becomes produced *after* a
 * failed `/fs/read` is retried under a different key rather than staying cached
 * as a miss.
 */
function useHostImage(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  producedFiles: Record<string, ProducedFileRef> | undefined,
): (path: string) => Promise<string | undefined> {
  const cache = useRef(new Map<string, Promise<string | undefined>>())
  // Object URLs pin their blob until revoked, so a long session that generated
  // a dozen images would hold a dozen megabytes past unmount.
  const objectUrls = useRef<string[]>([])
  useEffect(
    () => () => {
      for (const url of objectUrls.current) URL.revokeObjectURL(url)
      objectUrls.current = []
    },
    [],
  )
  return useCallback(
    (path: string) => {
      const produced = producedFiles?.[path]
      const key = produced ? `produced:${produced.fileId}` : `fs:${path}`
      const hit = cache.current.get(key)
      if (hit) return hit
      const pending =
        produced && sessionId
          ? // Fetched rather than pointed at: the panel may be talking to a
            // header-authenticated gateway, where a bare URL in an `<img src>`
            // carries no credential.
            client
              .readProducedFile(sessionId, produced.fileId)
              .then((blob) => {
                if (blob.size === 0) return undefined
                const url = URL.createObjectURL(blob)
                objectUrls.current.push(url)
                return url
              })
              .catch(() => undefined)
          : client
              .readHostFile(path)
              .then((file) => {
                if (file.encoding !== 'base64') return undefined
                // The route reports bytes and an encoding but not a media type;
                // the extension is what a browser needs to decode it.
                const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
                const mediaType = IMAGE_MEDIA_TYPES[extension]
                return mediaType ? `data:${mediaType};base64,${file.content}` : undefined
              })
              .catch(() => undefined)
      cache.current.set(key, pending)
      return pending
    },
    [client, sessionId, producedFiles],
  )
}

/** Extensions worth rendering inline, and what to call them. Anything else is
 * left to the card's path text — guessing a media type is how an HTML file ends
 * up in an `<img>`. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** A dismissible advisory strip above the transcript. */
function Notice({
  level,
  onDismiss,
  children,
}: {
  level: 'warning' | 'error'
  onDismiss?: () => void
  children: ReactNode
}) {
  return (
    <div className='px-3 pt-2'>
      <div
        role='alert'
        className={cn(
          'mx-auto flex w-full max-w-3xl items-start gap-2 rounded-md border px-3 py-2 text-body-sm',
          level === 'error'
            ? 'border-danger/40 bg-danger-bg text-danger'
            : 'border-warning/40 bg-warning-bg text-warning',
        )}>
        <TriangleAlert className='mt-0.5 size-3.5 shrink-0' />
        <span className='min-w-0 flex-1 break-words'>{children}</span>
        {onDismiss ? (
          <button
            type='button'
            onClick={onDismiss}
            aria-label='Dismiss'
            className='shrink-0 opacity-70 transition-opacity hover:opacity-100'>
            <X className='size-3.5' />
          </button>
        ) : null}
      </div>
    </div>
  )
}
