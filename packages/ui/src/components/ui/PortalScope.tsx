import { type FunctionComponent, type ReactNode } from 'react'

/**
 * Re-establishes the `.wd-root` styling scope inside a portal.
 *
 * The scoped stylesheet (`@workerdeck/ui/scoped.css`) rewrites every rule to
 * live under `.wd-root`, so an embedder's page keeps its own design system and
 * the panel keeps this one. Base UI popups (Menu, Dialog, AlertDialog, Select,
 * Tooltip) portal to `document.body` — OUTSIDE the embedder's wrapper — so
 * without this they would render unstyled, or worse, styled by the host.
 *
 * `display: contents` (inline, so no stylesheet needs to load for it) makes the
 * element generate no box: positioning, hit-testing and the popup's own layout
 * are untouched. It still carries the class, which is all the scope needs —
 * design tokens declared on `.wd-root` inherit through it, and every
 * `.wd-root <x>` rule matches below it. Theme keeps working because the dark
 * token block matches `[data-theme='dark']` on ANY ancestor, and `document.body`
 * sits under the host's themed `<html>` just like the panel does.
 *
 * Under the classic `theme.css` integration the class matches no rule and the
 * element is inert, so the wrapper is unconditional.
 */
export const PortalScope: FunctionComponent<{ children?: ReactNode }> = ({ children }) => (
  <div className="wd-root" style={{ display: 'contents' }}>
    {children}
  </div>
)
