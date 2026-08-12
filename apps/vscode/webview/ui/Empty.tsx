/**
 * The shared empty state, re-exported under the names this container already
 * uses. It lives in `@workerdeck/ui` now — the dashboard's sidebars are the
 * same shape of panel and should fail the same way — and this file stays so the
 * views here keep their local import.
 */
export { Empty, EmptyKey as Key } from '@workerdeck/ui'
