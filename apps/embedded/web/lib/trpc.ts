import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import type { WikiRouter } from '../../src/wiki/trpc.ts'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The agent edits the same rows from the other side, so a cached list is stale the moment a turn ends.
      staleTime: 0,
      retry: (failureCount, error) => failureCount < 2 && !isUnauthorized(error),
    },
  },
})

export const trpcClient = createTRPCClient<WikiRouter>({
  links: [httpBatchLink({ url: '/trpc' })],
})

export const trpc = createTRPCOptionsProxy<WikiRouter>({ client: trpcClient, queryClient })

export const isUnauthorized = (error: unknown): boolean => {
  return dataCode(error) === 'UNAUTHORIZED'
}

export const isNotFound = (error: unknown): boolean => {
  return dataCode(error) === 'NOT_FOUND'
}

const dataCode = (error: unknown): string | undefined => {
  const data = (error as { data?: { code?: unknown } } | null)?.data
  return typeof data?.code === 'string' ? data.code : undefined
}
