import type { Runner } from '@workerdeck/core'
import { HttpError } from '../lib/http.ts'
import { engineOf } from '../lib/profile-env.ts'

export async function sleepRunner(runner: Runner): Promise<void> {
  if (!runner.sleep) {
    throw new HttpError(501, `the ${engineOf(runner.info())} engine has no process to put to sleep`)
  }
  const result = await runner.sleep()
  if (!result.ok) {
    throw new HttpError(409, `cannot sleep: ${result.reason}`)
  }
}
