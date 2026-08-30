import type { WorkerDeckClient } from '@workerdeck/client'
import { primaryClient } from './hosts.ts'

/**
 * The **primary** gateway's client (`primaryClient()` in `hosts.ts`) — an accessor,
 * not a constant, because there is no longer such a thing as "the" client: a
 * session resolves its own from the route. Only the still-single-gateway surfaces
 * use this. Undefined until the same-origin probe answers, so callers must handle it.
 */
export const client = (): WorkerDeckClient | undefined => primaryClient()
