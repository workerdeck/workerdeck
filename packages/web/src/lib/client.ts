import { WorkerDeckClient } from '@workerdeck/client'

/** Single client against the dev proxy (`/v1` → the worker server). */
export const client = new WorkerDeckClient({ baseUrl: `${location.origin}/v1` })
