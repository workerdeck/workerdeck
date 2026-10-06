import { useMemo, useRef, useState } from 'react'
import { useNavigate, useRouterState, useSearch } from '@tanstack/react-router'
import {
  STATUS_LABEL_EMOJI_MAX,
  STATUS_LABEL_TEXT_MAX,
  filterRows,
  sessionLabel,
  type SessionRow,
  type SessionTask,
  type StatusLabelInput,
  errorMessage,
} from '@workerdeck/protocol'
import { runTeamMove, type WorkerDeckClient } from '@workerdeck/client'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  Empty,
  EngineIcon,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  SessionBrowser,
  type TeamMove,
  SessionFiltersButton,
  SessionStatusIcon,
  cn,
  toast,
  AvatarDialog,
  type GroupTarget,
} from '@workerdeck/ui'
import { ChevronDown, Layers, Plus, RefreshCw, Search, UserPlus } from 'lucide-react'
import { CreateSessionDialog } from '@/views/SessionsView.tsx'
import { NewAgentDialog } from '@/components/NewAgentDialog.tsx'
import { SessionCardActions, teamLeads, teamMembers, type CardAction } from './SessionCardActions.tsx'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { clientFor, hostById, primaryHost } from '@/lib/hosts.ts'
import { getSearchShown, setSearchShown } from '@/lib/sidebar.ts'
import { useProjectIcons } from '@workerdeck/react'
import { useSessionRows, useSessions } from '@/hooks/useSessions.ts'
import { useAgentAvatars } from '@/hooks/useAgentAvatars.ts'
import { useHostRelays } from '@/hooks/useHostRelays.ts'
import { useViewConfig } from '@/hooks/useViewConfig.ts'

export function SessionsSidebar() {
  const navigate = useNavigate()
  const activeId = useRouterState({
    select: (s) => s.location.pathname.match(/^\/sessions\/[^/]+\/(.+)$/)?.[1] ?? undefined,
  })
  // `strict: false` because this sidebar sits above the route that declares the param.
  const activeSubagentId = useSearch({ strict: false }).subagent
  const activeShellId = useSearch({ strict: false }).shell
  const { snapshots, refresh } = useSessions()
  const relays = useHostRelays()
  const rows = useSessionRows(snapshots)
  // `clientFor` is module scope and stable, so it is not a dependency that would re-fire the fetch.
  const projectIcons = useProjectIcons(rows, clientFor)
  const avatars = useAgentAvatars(rows)
  const failures = snapshots.filter((s) => s.error !== undefined)
  const primary = primaryHost()
  const [config, setConfig] = useViewConfig()
  const [creating, setCreating] = useState(false)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [renaming, setRenaming] = useState<SessionRow>()
  const [labeling, setLabeling] = useState<SessionRow>()
  const [avatarFor, setAvatarFor] = useState<SessionRow>()
  const [retiring, setRetiring] = useState<SessionRow>()
  // Kept after close so the dialog does not re-render against another gateway while it fades out.
  const [target, setTarget] = useState<Partial<GroupTarget>>({})
  const startCreate = (next: Partial<GroupTarget>) => {
    setTarget(next)
    setCreatingAgent(false)
    setCreating(true)
  }
  const startAgent = (next: Partial<GroupTarget>) => {
    setTarget(next)
    setCreating(false)
    setCreatingAgent(true)
  }
  const createHostId = target.hostId ?? primary?.id
  const createSessions = snapshots.find((snap) => snap.host.id === createHostId)?.sessions ?? []
  const createGatewayName = target.hostId && snapshots.length > 1 ? hostById(target.hostId)?.name : undefined
  const openCreated = (id: string) => {
    if (!createHostId) {
      return
    }
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: createHostId, sessionId: id },
      search: {},
    })
  }
  const [searchOpen, setSearchOpen] = useState(getSearchShown)
  // The rail renders rows itself, so it has to apply the filter `SessionBrowser` would: collapsing must not widen the list.
  const visible = useMemo(() => filterRows(rows, config), [rows, config])

  const open = (row: SessionRow) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      // Cleared explicitly, because an omitted `search` inherits the current one and would carry a framed sub-agent along.
      search: {},
    })

  const subagentNonce = useRef(0)
  const openSubagent = (row: SessionRow, toolUseId: string) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      search: { subagent: toolUseId, sn: ++subagentNonce.current },
    })

  const shellNonce = useRef(0)
  const openShell = (row: SessionRow, shellId: string) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      search: { shell: shellId, shn: ++shellNonce.current },
    })

  const killShell = (row: SessionRow, shellId: string) => {
    void clientFor(row.hostId)
      ?.killShell(row.info.id, shellId)
      .then(() => refresh())
      .catch((e: unknown) => toast.error(errorMessage(e, 'Kill failed')))
  }

  const shellAgentWrite = (row: SessionRow, shellId: string, enabled: boolean) => {
    void clientFor(row.hostId)
      ?.setShellAgentWrite(row.info.id, shellId, enabled)
      .then(() => refresh())
      .catch((e: unknown) => toast.error(errorMessage(e, enabled ? 'Grant failed' : 'Revoke failed')))
  }

  const rename = (row: SessionRow, title: string) => {
    void clientFor(row.hostId)
      ?.updateSession(row.info.id, { title: title || null })
      .then(() => refresh())
      .catch((e: unknown) => toast.error(errorMessage(e, 'Rename failed')))
  }

  const renameAgent = (row: SessionRow, name: string) => {
    const agent = row.info.agent
    if (agent && name) {
      agentCall(row, 'Rename failed', (client) => client.updateAgent(agent.id, { name }))
    }
  }

  // Rejects with the gateway's message, which the list draws under the card it was dropped on.
  const teamMove = async (move: TeamMove) => {
    const lead = move.lead?.info.agent?.id ?? null
    try {
      await runTeamMove(
        {
          mover: { hostId: move.row.hostId, sessionId: move.row.info.id, agentId: move.row.info.agent?.id },
          lead: lead && move.lead ? { hostId: move.lead.hostId, agentId: lead } : null,
          order: move.order,
          siblings: (move.siblings ?? []).flatMap(({ row, order }) =>
            row.info.agent ? [{ hostId: row.hostId, agentId: row.info.agent.id, order }] : [],
          ),
        },
        clientFor,
        (hostId) => relays[hostId],
      )
    } catch (e) {
      throw new Error(errorMessage(e, lead ? 'Could not join the team' : 'Could not leave the team'), { cause: e })
    } finally {
      void refresh()
    }
  }

  const agentCall = (row: SessionRow, failure: string, call: (client: WorkerDeckClient) => Promise<unknown>) => {
    const client = clientFor(row.hostId)
    if (!client) {
      return
    }
    void call(client)
      .then(() => refresh())
      .catch((e: unknown) => toast.error(errorMessage(e, failure)))
  }

  const clearContext = (row: SessionRow) => {
    const client = clientFor(row.hostId)
    if (!client) {
      return
    }
    // A clear is a session command, not a REST route, so this list borrows a socket for one frame.
    // `reconnect: false` is load-bearing: it must not become a second permanent subscriber to the session.
    const handle = client.attach(row.info.id, { reconnect: false })
    const done = setTimeout(() => {
      handle.detach()
      toast.error('Clear failed - the gateway did not answer')
    }, 5_000)
    handle.on('attached', () => {
      handle.clearContext()
      // Let the frame flush before the socket goes, so watchers see the `conversation_reset`.
      setTimeout(() => {
        clearTimeout(done)
        handle.detach()
        toast.success('Context cleared - the previous conversation stays resumable')
        void refresh()
      }, 150)
    })
  }

  const onCardAction = (row: SessionRow, action: CardAction) => {
    const agent = row.info.agent
    switch (action.kind) {
      case 'rename': {
        setRenaming(row)
        break
      }
      case 'status': {
        setLabeling(row)
        break
      }
      case 'avatar': {
        setAvatarFor(row)
        break
      }
      case 'clear': {
        clearContext(row)
        break
      }
      case 'sleep': {
        agentCall(row, 'Sleep failed', (client) => client.sleepSession(row.info.id))
        break
      }
      case 'close': {
        agentCall(row, 'Delete failed', (client) => client.deleteSession(row.info.id))
        break
      }
      case 'adopt': {
        agentCall(row, 'Could not make an agent', (client) => client.createAgent({ adopt: row.info.id }))
        break
      }
      case 'join': {
        const lead = action.lead.info.agent?.id
        agentCall(row, 'Could not join the team', (client) =>
          agent ? client.updateAgent(agent.id, { lead }) : client.createAgent({ adopt: row.info.id, lead }),
        )
        break
      }
      case 'leave': {
        if (agent) {
          agentCall(row, 'Could not leave the team', (client) => client.updateAgent(agent.id, { lead: null }))
        }
        break
      }
      case 'dissolve': {
        const members = teamMembers(row, rows)
        agentCall(row, 'Could not dissolve the team', async (client) => {
          for (const member of members) {
            await client.updateAgent(member.info.agent!.id, { lead: null })
          }
        })
        break
      }
      case 'restart': {
        if (agent) {
          agentCall(row, 'Could not restart the agent', async (client) => {
            const restarted = await client.restartAgent(agent.id)
            if (restarted.session && row.info.id === activeId) {
              open({ ...row, info: restarted.session })
            }
          })
        }
        break
      }
      case 'retire': {
        setRetiring(row)
        break
      }
    }
  }

  const toggleSearch = () => {
    const next = !searchOpen
    setSearchOpen(next)
    setSearchShown(next)
    if (!next && config.search) {
      setConfig({ ...config, search: '' })
    }
  }

  const stopTask = (row: SessionRow, toolUseId: string) => {
    void clientFor(row.hostId)
      ?.stopTask(row.info.id, toolUseId)
      .then(() => refresh())
      .catch((e: unknown) => toast.error(errorMessage(e, 'Stop failed')))
  }

  const revealNonce = useRef(0)
  const openTask = (row: SessionRow, task: SessionTask) =>
    void navigate({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: row.hostId, sessionId: row.info.id },
      search: task.toolUseId ? { reveal: task.toolUseId, rn: ++revealNonce.current } : {},
    })

  const newAgent = (
    <Button variant="ghost" size="icon-sm" aria-label="New agent" title="New agent" onClick={() => startAgent({})}>
      <UserPlus className="size-4" />
    </Button>
  )
  const create = (
    <span className="flex items-center">
      {newAgent}
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="More ways to start" title="New session or agent" className="w-4">
              <ChevronDown className="size-3" />
            </Button>
          }
        />
        <MenuContent>
          <MenuItem onClick={() => startAgent({})}>
            <UserPlus className="size-3.5 text-fg-3" /> New agent
          </MenuItem>
          <MenuItem onClick={() => startCreate({})}>
            <Plus className="size-3.5 text-fg-3" /> New one-off session
          </MenuItem>
        </MenuContent>
      </Menu>
    </span>
  )

  return (
    <>
      <SidebarFrame
        section="sessions"
        title="Sessions"
        railActions={newAgent}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={searchOpen ? 'Hide search' : 'Search sessions'}
              aria-pressed={searchOpen}
              onClick={toggleSearch}
            >
              <Search className={cn('size-3.5', searchOpen && 'text-fg-1')} />
            </Button>
            <SessionFiltersButton config={config} onConfigChange={setConfig} rows={rows} />
            <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
            </Button>
            {create}
          </>
        }
        rail={visible.map((row) => (
          <button
            key={row.info.id}
            type="button"
            title={`${sessionLabel(row.info)} - ${row.state}`}
            aria-label={sessionLabel(row.info)}
            onClick={() => open(row)}
            className={cn(
              'flex w-full flex-col items-center gap-0.5 border-l-2 py-1.5',
              row.info.id === activeId ? 'border-l-accent bg-row-active' : 'border-l-transparent hover:bg-row-hover',
            )}
          >
            <EngineIcon engine={row.adapter} model={row.info.model} className="size-4" />
            <SessionStatusIcon row={row} />
          </button>
        ))}
      >
        {failures.map(({ host, error }) => (
          <div key={host.id} className="mx-2 mb-2 rounded-md bg-danger-bg px-2 py-1.5 text-label text-danger">
            Can’t reach {host.name}: {error}
          </div>
        ))}

        <SidebarBody>
          <SessionBrowser
            rows={rows}
            config={config}
            onConfigChange={setConfig}
            showControls={false}
            showSearch={searchOpen}
            autoFocusSearch
            projectIcons={projectIcons}
            activeId={activeId}
            activeSubagentId={activeSubagentId}
            activeShellId={activeShellId}
            onSelect={open}
            onSelectSubagent={openSubagent}
            onSelectTask={openTask}
            onStopTask={stopTask}
            onSelectShell={openShell}
            onKillShell={killShell}
            onShellAgentWrite={shellAgentWrite}
            onCreateInGroup={startCreate}
            onRename={rename}
            onRenameAgent={renameAgent}
            onTeamMove={teamMove}
            relays={relays}
            avatars={avatars}
            rowActions={(row) => <SessionCardActions row={row} rows={rows} onAction={(action) => onCardAction(row, action)} />}
            emptyState={
              <Empty icon={<Layers />} title="No sessions yet" description={<>Start an agent or a session from the buttons above.</>} />
            }
          />
        </SidebarBody>
      </SidebarFrame>

      <CreateSessionDialog
        open={creating}
        onOpenChange={setCreating}
        sessions={createSessions}
        target={target}
        gatewayName={createGatewayName}
        onCreated={(id) => {
          setCreating(false)
          openCreated(id)
          void refresh()
        }}
      />

      <NewAgentDialog
        open={creatingAgent}
        onOpenChange={setCreatingAgent}
        sessions={createSessions}
        leads={teamLeads(rows, createHostId)}
        target={target}
        gatewayName={createGatewayName}
        onCreated={(id) => {
          setCreatingAgent(false)
          openCreated(id)
          void refresh()
        }}
        onOneOff={(next) => startCreate({ hostId: next.hostId, cwd: next.cwd })}
      />

      <AvatarDialog
        client={avatarFor ? clientFor(avatarFor.hostId) : undefined}
        agent={avatarFor?.info.agent}
        onClose={() => setAvatarFor(undefined)}
        onChanged={() => void refresh()}
      />

      <StatusDialog
        row={labeling}
        onClose={() => setLabeling(undefined)}
        onSave={(row, statusLabel) =>
          agentCall(row, 'Could not set the status', (client) => client.updateSession(row.info.id, { statusLabel }))
        }
      />

      <RenameDialog
        row={renaming}
        onClose={() => setRenaming(undefined)}
        onRename={(row, name) => (row.info.agent ? renameAgent(row, name) : rename(row, name))}
      />

      <AlertDialog open={retiring !== undefined} onOpenChange={(next) => !next && setRetiring(undefined)}>
        <AlertDialogContent>
          <AlertDialogTitle>Retire {retiring?.info.agent?.name ?? 'this agent'}?</AlertDialogTitle>
          <AlertDialogDescription>
            The agent and its session end. {retiring?.info.agent?.leads ? 'Its members are released and stay as agents. ' : ''}Past
            conversations stay resumable from the engine&apos;s store.
          </AlertDialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              onClick={() => {
                const row = retiring
                const agent = row?.info.agent
                setRetiring(undefined)
                if (row && agent) {
                  agentCall(row, 'Could not retire the agent', (client) => client.retireAgent(agent.id))
                }
              }}
            >
              Retire
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function RenameDialog({
  row,
  onClose,
  onRename,
}: {
  row?: SessionRow
  onClose: () => void
  onRename: (row: SessionRow, name: string) => void
}) {
  return (
    <Dialog open={row !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title={row?.info.agent ? 'Rename agent' : 'Rename session'} />
        <DialogBody>{row ? <RenameForm key={row.info.id} row={row} onClose={onClose} onRename={onRename} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function RenameForm({
  row,
  onClose,
  onRename,
}: {
  row: SessionRow
  onClose: () => void
  onRename: (row: SessionRow, name: string) => void
}) {
  const agent = row.info.agent
  const [value, setValue] = useState(agent ? agent.name : (row.info.title ?? ''))
  const name = value.trim()
  const submit = () => {
    if (agent && !name) {
      return
    }
    onRename(row, name)
    onClose()
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={agent ? 'Agent name' : 'Session name'}
        spellCheck={false}
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={agent !== undefined && !name}>
          Rename
        </Button>
      </div>
    </form>
  )
}

function StatusDialog({
  row,
  onClose,
  onSave,
}: {
  row?: SessionRow
  onClose: () => void
  onSave: (row: SessionRow, label: StatusLabelInput | null) => void
}) {
  return (
    <Dialog open={row !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="sm">
        <DialogHeader title="Status" />
        <DialogBody>{row ? <StatusForm key={row.info.id} row={row} onClose={onClose} onSave={onSave} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function StatusForm({
  row,
  onClose,
  onSave,
}: {
  row: SessionRow
  onClose: () => void
  onSave: (row: SessionRow, label: StatusLabelInput | null) => void
}) {
  const [emoji, setEmoji] = useState(row.info.statusLabel?.emoji ?? '')
  const [text, setText] = useState(row.info.statusLabel?.text ?? '')
  const save = (label: StatusLabelInput | null) => {
    onSave(row, label)
    onClose()
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        save(text.trim() ? { text: text.trim(), ...(emoji.trim() ? { emoji: emoji.trim() } : {}) } : null)
      }}
    >
      <div className="flex gap-2">
        <Input
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          placeholder="🙂"
          aria-label="Emoji"
          maxLength={STATUS_LABEL_EMOJI_MAX}
          className="w-12 text-center"
        />
        <Input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What is this session doing?"
          aria-label="Status"
          maxLength={STATUS_LABEL_TEXT_MAX}
          spellCheck={false}
        />
      </div>
      <p className="text-label text-fg-4">Shown under the name in the session list. The agent can change it with set_status.</p>
      <div className="flex justify-end gap-2">
        {row.info.statusLabel ? (
          <Button variant="outline" onClick={() => save(null)}>
            Clear
          </Button>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  )
}
