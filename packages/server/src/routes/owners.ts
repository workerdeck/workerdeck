import type { IncomingMessage, ServerResponse } from 'node:http'
import { isOwnerName, type RenameOwnerRequest, type RenameOwnerResponse } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import { withOwnerRenamed, type SessionRecord } from '../services/session-records.ts'

export async function handleOwnerRename(ctx: ServerContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  requireMethod(req, 'POST')
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as Partial<RenameOwnerRequest>
  const { from, to } = body
  if (!isOwnerName(from) || !isOwnerName(to)) {
    fail(400, 'from and to must be owner names: 1 to 32 lowercase letters, digits or dashes')
  }
  if (from === to) {
    fail(400, 'from and to are the same owner')
  }
  if (!ctx.owners.known(to)) {
    fail(409, `this gateway does not know the owner ${to}; name it in config, a profile or the relay enrollment first`)
  }
  const agents = await ctx.agents.renameOwner(from, to)
  if ('status' in agents) {
    fail(agents.status, agents.error)
  }
  // Per session, under its lifecycle lock with wakes fenced; parking's pass after it covers configs with no record.
  // A rename relabels: when `to` already names someone, both become one authorization identity.
  const sessions = new Set<string>()
  for (const listed of await ctx.records.list()) {
    await ctx.locks.run([listed.id], async () => {
      const fencedBefore = ctx.parking.fenced(listed.id)
      await ctx.parking.fence(listed.id)
      try {
        if (await renameSession(ctx, listed.id, from, to)) {
          sessions.add(listed.id)
        }
      } finally {
        if (!fencedBefore) {
          ctx.parking.unfence(listed.id)
        }
      }
    })
  }
  for (const id of await ctx.parking.renameOwner(from, to)) {
    sessions.add(id)
  }
  const stored = await ctx.parking.listInfo()
  ctx.owners.rebuildRetained([...ctx.agents.owners(), ...[...ctx.registry.list(), ...stored].map((info) => info.owner)])
  ctx.teams?.republish()
  json(res, 200, { agents: agents.renamed, sessions: sessions.size } satisfies RenameOwnerResponse)
}

// Every copy of one session's owner moves in one step, with wakes fenced: a wake in flight never registers a runner
// built from the old owner.
async function renameSession(ctx: ServerContext, id: string, from: string, to: string): Promise<boolean> {
  let renamed: SessionRecord | undefined
  await ctx.records.transact(id, (current) => {
    renamed = current ? withOwnerRenamed(current, from, to) : undefined
    return renamed
  })
  if (!renamed) {
    return false
  }
  for (const entry of renamed.conversations) {
    ctx.cuts.refreshEntry(id, entry)
  }
  const live = ctx.registry.get(id)
  if (live?.info().owner === from) {
    live.setOwner?.(to)
  }
  const config = ctx.parking.configOf(id)
  if (config?.owner === from) {
    ctx.parking.remember(id, { ...config, owner: to })
  }
  const row = ctx.agents.get(id)
  if (row && row.owner !== renamed.owner && !ctx.agents.frozen(id)) {
    await ctx.agents.patch(id, (agent) => ({ ...agent, owner: renamed!.owner }))
  }
  return true
}
