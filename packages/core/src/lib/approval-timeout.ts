// A gateway-level default, a per-session override, and 'never expire' as a value both can carry:
// null (or any non-positive number) means the prompt waits for a human for as long as the session lives.
export function resolveApprovalTimeoutMs(session: number | null | undefined, fallback: number | null | undefined): number | undefined {
  const value = session === undefined ? fallback : session
  return value === undefined || value === null || value <= 0 ? undefined : value
}
