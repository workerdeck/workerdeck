import { type FunctionComponent, type ReactNode } from 'react'

export const PortalScope: FunctionComponent<{ children?: ReactNode }> = ({ children }) => (
  <div className="wd-root" style={{ display: 'contents' }}>
    {children}
  </div>
)
