import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { WikiRouter } from '../src/wiki-api.ts'

/**
 * The wiki's data API, typed straight off the server's actions.
 *
 * `WikiRouter` is `InferTrpcRouter<…>` over the same action set the agent
 * reaches by MCP — so there is no generated client, no shared DTO file, and no
 * way for the two to disagree. Add an action and it appears here; change an
 * input schema and the call site stops compiling.
 *
 * Same origin as the gateway, so the login cookie rides every call and the tab
 * holds no token. `credentials` is left at its default for exactly that reason:
 * same-origin requests send cookies already, and setting `include` would only
 * matter for a cross-origin deployment this app deliberately does not have.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The agent edits the same rows from the other side, so a cached list is
      // stale the moment a turn ends. Refetching is cheap and local; guessing is
      // how a user watches the agent say it wrote something that isn't there.
      staleTime: 0,
      retry: (failureCount, error) => failureCount < 2 && !isUnauthorized(error),
    },
  },
})

export const trpcClient = createTRPCClient<WikiRouter>({
  links: [httpBatchLink({ url: '/trpc' })],
})

/** `trpc.listDocs.queryOptions()`, `trpc.writeDoc.mutationOptions()`, … */
export const trpc = createTRPCOptionsProxy<WikiRouter>({ client: trpcClient, queryClient })

/** Signed out, as opposed to broken — the cookie expired or was cleared. */
export function isUnauthorized(error: unknown): boolean {
  return dataCode(error) === 'UNAUTHORIZED'
}

/** The document is gone — the agent, or another tab, deleted it. */
export function isNotFound(error: unknown): boolean {
  return dataCode(error) === 'NOT_FOUND'
}

function dataCode(error: unknown): string | undefined {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : undefined
}
