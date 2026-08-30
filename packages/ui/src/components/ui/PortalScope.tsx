import { type FunctionComponent, type ReactNode } from 'react'

/**
 * Re-establishes the `.wd-root` styling scope inside a portal. Base UI popups portal
 * to `document.body`, outside the embedder's wrapper, so under `scoped.css` (every
 * rule rewritten under `.wd-root`) they would otherwise render unstyled or host-styled.
 *
 * `display: contents` is inline so it needs no stylesheet, and generates no box:
 * positioning, hit-testing and the popup's layout are untouched. Under the classic
 * `theme.css` integration the class matches nothing, so the wrapper is unconditional.
 */
export const PortalScope: FunctionComponent<{ children?: ReactNode }> = ({ children }) => (
  <div className="wd-root" style={{ display: 'contents' }}>
    {children}
  </div>
)
