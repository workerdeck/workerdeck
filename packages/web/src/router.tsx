import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
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
   * `?subagent=<toolUseId>&sn=<n>` — open the session with one sub-agent's work
   * framed, which is how the sessions list hands a running agent over.
   *
   * In the URL rather than in component state so the takeover is addressable:
   * the sidebar navigates across a route change, and a piece of state on the
   * far side of that is a piece of state the navigation cannot carry. `sn` is
   * the nonce the panel needs to treat asking twice as twice — a plain repeat
   * of the same id is a props-equal no-op.
   */
  validateSearch: (search: Record<string, unknown>): { subagent?: string; sn?: number } => ({
    subagent: typeof search.subagent === 'string' ? search.subagent : undefined,
    sn: typeof search.sn === 'number' ? search.sn : undefined,
  }),
})

/**
 * The address this app used before it could hold more than one gateway. Kept as
 * a redirect so links and bookmarks made then still open — they can only ever
 * have meant the gateway that served the page.
 */
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

/**
 * Settings became a dialog the shell opens, so this address no longer names a
 * screen. Kept as a redirect rather than deleted: it was a real bookmark, and a
 * blank page is a worse answer than the sessions list.
 */
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
