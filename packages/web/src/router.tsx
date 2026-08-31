import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router'
import { AppShell } from '@/components/shell/AppShell.tsx'
import { IMPLICIT_HOST_ID } from '@/lib/hosts.ts'
import { GatewayView } from '@/views/GatewayView.tsx'
import { GatewaysView } from '@/views/GatewaysView.tsx'
import { JobView } from '@/views/JobView.tsx'
import { JobsView } from '@/views/JobsView.tsx'
import { ProfileView } from '@/views/ProfileView.tsx'
import { ProfilesView } from '@/views/ProfilesView.tsx'
import { SessionView } from '@/views/SessionView.tsx'
import { SessionsView } from '@/views/SessionsView.tsx'

const rootRoute = createRootRoute({ component: AppShell })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/sessions' })
  },
})

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsView,
})

// The gateway is part of a session's address because a session id is unique only within one gateway.
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$hostId/$sessionId',
  component: SessionView,
  // `sn`/`rn` are nonces: without them a repeat of the same id is a props-equal no-op, and asking twice must count twice.
  validateSearch: (search: Record<string, unknown>): { subagent?: string; sn?: number; reveal?: string; rn?: number } => ({
    subagent: typeof search.subagent === 'string' ? search.subagent : undefined,
    sn: typeof search.sn === 'number' ? search.sn : undefined,
    reveal: typeof search.reveal === 'string' ? search.reveal : undefined,
    rn: typeof search.rn === 'number' ? search.rn : undefined,
  }),
})

const legacySessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$sessionId',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/sessions/$hostId/$sessionId',
      params: { hostId: IMPLICIT_HOST_ID, sessionId: params.sessionId },
      search: {},
    })
  },
})

const gatewaysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateways',
  component: GatewaysView,
})

const gatewayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateways/$hostId',
  component: GatewayView,
})

const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: JobsView,
})

const jobRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs/$jobId',
  component: JobView,
})

const profilesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profiles',
  component: ProfilesView,
})

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/profiles/$profileName',
  component: ProfileView,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    throw redirect({ to: '/sessions' })
  },
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    sessionsRoute,
    sessionRoute,
    legacySessionRoute,
    gatewaysRoute,
    gatewayRoute,
    jobsRoute,
    jobRoute,
    profilesRoute,
    profileRoute,
    settingsRoute,
  ]),
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
