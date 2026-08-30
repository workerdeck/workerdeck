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

/**
 * Every section is a pair: a list route whose component is the empty detail
 * pane (the list itself is the shell's sidebar), and a detail route under it.
 */
const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions',
  component: SessionsView,
})

/**
 * The gateway is part of a session's address, because a session id is only
 * unique *within* one gateway — two of them can hand out the same id, and a
 * bare `/sessions/:id` would open whichever happened to answer first.
 */
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sessions/$hostId/$sessionId',
  component: SessionView,
  /**
   * `?subagent=<toolUseId>` frames one sub-agent's work; `?reveal=<toolUseId>`
   * stays on the conversation and travels to a row in it. Two pairs, not a flag,
   * because they mean different things to the panel — a **task** has no agent
   * behind it, so framing its tool-use id draws an empty agent view.
   *
   * In the URL rather than component state so the takeover survives the route
   * change the sidebar navigates across. `sn`/`rn` are nonces: without them a
   * repeat of the same id is a props-equal no-op, and asking twice must count twice.
   */
  validateSearch: (search: Record<string, unknown>): { subagent?: string; sn?: number; reveal?: string; rn?: number } => ({
    subagent: typeof search.subagent === 'string' ? search.subagent : undefined,
    sn: typeof search.sn === 'number' ? search.sn : undefined,
    reveal: typeof search.reveal === 'string' ? search.reveal : undefined,
    rn: typeof search.rn === 'number' ? search.rn : undefined,
  }),
})

/** Pre-multi-gateway address, kept as a redirect: it can only ever have meant the serving gateway. */
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

/** Settings is a dialog now, but this was a real bookmark. */
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
  // Static bundle with no server SPA fallback — hash history keeps deep links working.
  history: createHashHistory(),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
