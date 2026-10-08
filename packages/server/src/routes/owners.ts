import type { IncomingMessage, ServerResponse } from 'node:http'
import { isOwnerName, type RenameOwnerRequest, type RenameOwnerResponse } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'

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
  const sessions = await ctx.parking.renameOwner(from, to)
  const stored = await ctx.parking.listInfo()
  ctx.owners.rebuildRetained([...ctx.agents.owners(), ...[...ctx.registry.list(), ...stored].map((info) => info.owner)])
  ctx.teams?.republish()
  json(res, 200, { agents: agents.renamed, sessions } satisfies RenameOwnerResponse)
}
