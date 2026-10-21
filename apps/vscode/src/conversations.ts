import * as vscode from 'vscode'
import { conversationDate, conversationRowText } from '@workerdeck/ui/format'
import { errorMessage, type AgentConversationsResponse, type RetiredAgentInfo } from '@workerdeck/protocol'
import type { GatewayHost, HostStore } from './hosts.ts'
import { clientFor } from './gateway.ts'
import type { SelectOptions } from './sidebar.ts'

type Row = AgentConversationsResponse['conversations'][number]

export type ConversationsDeps = {
  store: HostStore
  selectSession: (hostId: string, sessionId: string, options?: SelectOptions) => Promise<void>
}

export type ConversationsAgent = { hostId: string; agentId: string; name: string; deleted?: boolean }

export function deleteAgentDetail(name: string): string {
  return `${name} leaves your agents. Its conversations stay under Past agents. Team members are released.`
}

// The current conversation opens as the agent (it follows), a past one in its own editor tab that never follows.
export async function showConversations(deps: ConversationsDeps, agent: ConversationsAgent): Promise<void> {
  const host = deps.store.get(agent.hostId)
  const client = host && (await clientFor(deps.store, host))
  if (!client) {
    return
  }
  let rows: Row[]
  try {
    rows = (await client.agentConversations(agent.agentId)).conversations
  } catch (err) {
    void vscode.window.showErrorMessage(`WorkerDeck: could not list the conversations - ${errorMessage(err)}`)
    return
  }
  const now = Date.now()
  const picked = await vscode.window.showQuickPick(
    rows.map((row) => {
      const text = conversationRowText({ ...row, title: row.title ?? row.session?.title }, now)
      const current = text.current && !agent.deleted
      return {
        label: `${current ? '$(circle-filled)' : '$(history)'} ${text.title}`,
        description: current ? 'current' : undefined,
        detail: [text.date, text.duration].filter(Boolean).join(' · '),
        row,
        current,
      }
    }),
    { title: `${agent.name}: conversations`, placeHolder: rows.length ? 'Past conversations open read-only' : 'No conversations yet' },
  )
  if (!picked) {
    return
  }
  await deps.selectSession(agent.hostId, agent.agentId, picked.current ? {} : { target: 'editor' })
}

export async function showPastAgents(deps: ConversationsDeps): Promise<void> {
  const hosts = deps.store.all()
  const lists = await Promise.all(hosts.map((host) => retiredOn(deps.store, host)))
  const rows = lists.flat().sort((a, b) => b.agent.retiredAt - a.agent.retiredAt)
  const many = hosts.length > 1
  const picked = await vscode.window.showQuickPick(
    rows.map(({ host, agent }) => {
      const count = agent.conversations.length
      return {
        label: `$(person) ${agent.name}`,
        description: many ? host.name : undefined,
        detail: `Deleted ${conversationDate(agent.retiredAt)} · ${count} conversation${count === 1 ? '' : 's'}`,
        host,
        agent,
      }
    }),
    { title: 'Past agents', placeHolder: rows.length ? 'Deleted agents keep their conversations here' : 'No deleted agents' },
  )
  if (picked) {
    await showConversations(deps, { hostId: picked.host.id, agentId: picked.agent.id, name: picked.agent.name, deleted: true })
  }
}

async function retiredOn(store: HostStore, host: GatewayHost): Promise<{ host: GatewayHost; agent: RetiredAgentInfo }[]> {
  const client = await clientFor(store, host)
  const retired = (await client?.retiredAgents().catch((): RetiredAgentInfo[] => [])) ?? []
  return retired.map((agent) => ({ host, agent }))
}
