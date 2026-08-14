import { useCallback, useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import type { SessionInfo } from '@workerdeck/protocol'
import { SessionPanel } from '@workerdeck/ui'
import { api } from '../lib/api.ts'
import type { AgentConfigResponse } from '../../src/shared.ts'

export type AgentSidebarProps = {
  /** Bumped by the app whenever a session event suggests the wiki changed. */
  onWikiMaybeChanged: () => void
}

/**
 * The right-hand rail: the user's agent sessions, and the live one.
 *
 * Three things here are the embedding pattern rather than app code:
 *
 * - **One client for the whole tab.** `baseUrl: '/v1'` and nothing else — same
 *   origin, so the wiki's own cookie authenticates both the REST calls and the
 *   WebSocket upgrade. A second client would open a second socket and split the
 *   panel's "first attached client" in two.
 * - **`listSessions()` needs no filter.** The gateway already answers only with
 *   this user's sessions, because the principal carries `scope: { user }`. There
 *   is no `?mine=true` here and there must not be one — an ownership check the
 *   client performs is an ownership check the client can skip.
 * - **Switching sessions is a remount**, via `key`. That is the documented way:
 *   the panel owns one attach for its lifetime.
 */
export function AgentSidebar({ onWikiMaybeChanged }: AgentSidebarProps) {
  const [config, setConfig] = useState<AgentConfigResponse | undefined>()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [creating, setCreating] = useState(false)

  const client = useMemo(() => new WorkerDeckClient({ baseUrl: '/v1' }), [])

  const refresh = useCallback(async () => {
    try {
      const list = await client.listSessions()
      setSessions(list.filter((s) => s.status !== 'closed'))
      return list
    } catch (e) {
      setError((e as Error).message)
      return []
    }
  }, [client])

  useEffect(() => {
    api.agent().then(setConfig).catch((e: Error) => setError(e.message))
    void refresh().then((list) => {
      const live = list.filter((s) => s.status !== 'closed')
      if (live[0]) setActiveId(live[0].id)
    })
  }, [refresh])

  // The list is polled rather than pushed: the sessions list has no socket of
  // its own, and this rail shows a handful of rows.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  }, [refresh])

  const startSession = async () => {
    if (!config) return
    setCreating(true)
    setError(undefined)
    try {
      // No `cwd`: this engine has no host filesystem, and the gateway takes none
      // for it (`EngineCapabilities.hostCwd === false`). No `scope` either — the
      // gateway stamps it from the principal, and a client-supplied one could
      // only agree or be refused.
      const session = await client.createSession({ profile: config.profile })
      setActiveId(session.id)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const endSession = async (id: string) => {
    await client.deleteSession(id).catch(() => {})
    const list = await refresh()
    if (activeId === id) setActiveId(list.find((s) => s.status !== 'closed')?.id)
  }

  return (
    <aside className='flex h-full w-[26rem] shrink-0 flex-col border-l border-border bg-sidebar'>
      <header className='flex items-center gap-1 border-b border-border px-3 py-2'>
        <span className='text-xs font-semibold uppercase tracking-wide text-fg-3'>Agent</span>
        <div className='flex-1' />
        {sessions.length > 1 && (
          <select
            value={activeId ?? ''}
            onChange={(e) => setActiveId(e.target.value || undefined)}
            className='max-w-[11rem] truncate rounded border border-border bg-surface px-1.5 py-0.5 text-xs text-fg-2 outline-none'
          >
            {sessions.map((s, i) => (
              <option key={s.id} value={s.id}>
                {s.title ?? `Session ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        {activeId && (
          <button
            type='button'
            onClick={() => void endSession(activeId)}
            title='End this session'
            className='rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-row-hover hover:text-fg-1'
          >
            End
          </button>
        )}
        <button
          type='button'
          onClick={() => void startSession()}
          disabled={creating || !config?.available}
          title={config?.unavailableReason ?? 'New session'}
          aria-label='New session'
          className='rounded px-1.5 text-base leading-none text-fg-3 hover:bg-row-hover hover:text-fg-1 disabled:opacity-40'
        >
          +
        </button>
      </header>

      {error && <p className='border-b border-border px-3 py-2 text-xs text-danger'>{error}</p>}

      <div className='min-h-0 flex-1'>
        {activeId ? (
          <SessionPanel
            // Remount on switch: the panel owns one attach for its lifetime.
            key={activeId}
            client={client}
            sessionId={activeId}
            className='h-full'
            // A 26rem rail has no room for cards or for a two-row composer, and
            // the terminal theme is the densest thing there is: every row on a
            // character cell, nothing boxed. (Density reaches `cards` only, so
            // there is nothing to set beside it.)
            transcriptVariant='terminal'
            // The model and permission pickers move into the panel's own status
            // bar; this app's chrome has nowhere to put them.
            controlsSurface='status'
            focusComposerOnClick
            // Cheap change detection: the wiki tools are the only writers, so a
            // finished turn is the moment to re-read the document list.
            onVitals={(vitals) => {
              if (vitals.status === 'idle') onWikiMaybeChanged()
            }}
          />
        ) : (
          <EmptyState
            available={config?.available ?? false}
            reason={config?.unavailableReason}
            onStart={() => void startSession()}
          />
        )}
      </div>
    </aside>
  )
}

function EmptyState({
  available,
  reason,
  onStart,
}: {
  available: boolean
  reason?: string
  onStart: () => void
}) {
  return (
    <div className='flex h-full flex-col items-center justify-center gap-3 px-6 text-center'>
      <p className='text-sm text-fg-2'>No agent session yet.</p>
      <p className='text-xs text-fg-3'>
        It can read and write your wiki, run JavaScript in a sandbox, and fetch a public URL. It has
        no shell and no access to this machine&rsquo;s files.
      </p>
      {available ? (
        <button
          type='button'
          onClick={onStart}
          className='rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover'
        >
          Start a session
        </button>
      ) : (
        <p className='rounded border border-border bg-surface px-3 py-2 text-xs text-fg-3'>
          The server has no model credentials — {reason ?? 'set OPENAI_API_KEY'} and restart.
        </p>
      )}
    </div>
  )
}
