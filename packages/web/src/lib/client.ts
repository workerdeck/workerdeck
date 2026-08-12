import type { WorkerDeckClient } from '@workerdeck/client'
import { primaryClient } from './hosts.ts'

/**
 * The **primary** gateway's client — see `primaryClient()` in `hosts.ts`.
 *
 * This used to be one module-scope client against `location.origin`, back when
 * a dashboard talked to exactly one gateway. It survives as a named accessor
 * rather than a constant because there is no longer such a thing as "the"
 * client: sessions each belong to a gateway and resolve theirs from the route
 * (`clientFor(hostId)`), and what is left here are the surfaces that are still
 * single-gateway — jobs, profiles, and the create form's pickers.
 *
 * Undefined before the same-origin probe answers, and on a standalone build
 * with no gateways configured yet. Callers must handle that rather than assume
 * a gateway exists.
 */
export function client(): WorkerDeckClient | undefined {
  return primaryClient()
}
