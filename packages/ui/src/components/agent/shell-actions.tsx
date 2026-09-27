import { createContext, useContext, useEffect, type ReactNode } from 'react'
import type { ShellItem } from '@workerdeck/react'
import { AgentWriteAction, BookmarkAction, CopyAction, KillShellAction, OpenShellAction } from '../terminal/affordances.tsx'
import { shellAgentWriteLabel, shellGrantable } from '../terminal/shell-row.ts'

export type ShellActions = {
  loadOutput: (shellId: string) => Promise<boolean>
  verify: (shellId: string) => Promise<boolean>
  kill: (shellId: string) => Promise<boolean>
  // Drill in to the shell's terminal. Absent when the host has no frame to open one in.
  open?: (shellId: string) => void
  // Grant or revoke the agent's hand on a shell the user started. Absent where the agent holds no write tools.
  agentWrite?: (shellId: string, enabled: boolean) => Promise<boolean>
}

const NOOP: ShellActions = {
  loadOutput: async () => false,
  verify: async () => false,
  kill: async () => false,
}

const ShellActionsContext = createContext<ShellActions>(NOOP)

export function ShellActionsProvider({ value, children }: { value: ShellActions | undefined; children: ReactNode }) {
  return <ShellActionsContext.Provider value={value ?? NOOP}>{children}</ShellActionsContext.Provider>
}

export function useShellActions(): ShellActions {
  return useContext(ShellActionsContext)
}

// A row that still says running re-asks the gateway once, so a shell that died while nobody watched stops claiming it runs.
export function useVerifyRunning(item: ShellItem): void {
  const verify = useShellActions().verify
  const running = item.shell.status === 'running'
  const shellId = item.shell.id
  useEffect(() => {
    if (running) {
      void verify(shellId)
    }
  }, [running, shellId, verify])
}

export function ShellItemActions({ item }: { item: ShellItem }) {
  const actions = useShellActions()
  const shellId = item.shell.id
  return (
    <>
      {actions.open ? <OpenShellAction onOpen={() => actions.open?.(shellId)} /> : null}
      {actions.agentWrite && shellGrantable(item.shell) ? (
        <AgentWriteAction
          granted={item.shell.agentWrite === true}
          label={shellAgentWriteLabel(item.shell)}
          onToggle={() => void actions.agentWrite?.(shellId, item.shell.agentWrite !== true)}
        />
      ) : null}
      {item.shell.status === 'running' ? <KillShellAction onKill={() => void actions.kill(shellId)} /> : null}
      <BookmarkAction id={item.id} />
      <CopyAction text={item.shell.command} label="Copy command" />
    </>
  )
}
