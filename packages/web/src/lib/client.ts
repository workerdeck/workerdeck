import type { WorkerDeckClient } from '@workerdeck/client'
import { primaryClient } from './hosts.ts'

// Undefined until the same-origin probe answers, so every caller has to handle that.
export const client = (): WorkerDeckClient | undefined => primaryClient()
