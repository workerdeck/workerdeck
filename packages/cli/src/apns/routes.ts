import type { IncomingMessage, ServerResponse } from 'node:http'
import { createActivityRoute, type ActivityRegistry } from './activities.ts'
import { createDeviceRoute, type DeviceRegistry } from './devices.ts'

export type ApnsRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>

// One object owns every `/apns/*` path in both states the gateway can be in. Passing null is a
// gateway with no forwarder: the paths are still claimed, and answer 404 rather than falling
// through to the dashboard's SPA catch-all, which serves GET and HEAD and would answer 405.
export function createApnsRoute(
  registries: { devices: DeviceRegistry; activities: ActivityRegistry } | null,
  authenticate: (req: IncomingMessage) => unknown,
): ApnsRouteHandler {
  const device = createDeviceRoute(registries?.devices ?? null, authenticate)
  const activity = createActivityRoute(registries?.activities ?? null, authenticate)
  return async (req, res) => (await device(req, res)) || activity(req, res)
}
