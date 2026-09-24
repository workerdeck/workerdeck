import { createContext, useContext, type ReactNode } from 'react'

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
