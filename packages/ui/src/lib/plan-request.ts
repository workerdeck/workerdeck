type PlanRequestLike = { toolName?: unknown; input?: unknown }

export function planFromRequest(request: PlanRequestLike | null | undefined): string | undefined {
  if (request?.toolName !== 'ExitPlanMode') {
    return undefined
  }
  const input = request.input
  if (input === null || typeof input !== 'object') {
    return undefined
  }
  const plan = (input as { plan?: unknown }).plan
  if (typeof plan !== 'string' || plan.trim().length === 0) {
    return undefined
  }
  return plan
}
