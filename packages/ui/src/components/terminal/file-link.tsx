import { createContext, useContext, type ReactNode } from 'react'

export type FileLinkOpener = (path: string, line?: number) => void

export type FileLinkHandle = {
  cwd?: string
  open: FileLinkOpener
}

const FileLinkContext = createContext<FileLinkHandle | undefined>(undefined)

// A missing provider leaves every link an ordinary anchor, so embeddings that have nowhere to
// open a file pay nothing - the same contract BookmarkContext has.
export function FileLinkProvider({ value, children }: { value: FileLinkHandle | undefined; children: ReactNode }) {
  return <FileLinkContext.Provider value={value}>{children}</FileLinkContext.Provider>
}

export function useFileLinks(): FileLinkHandle | undefined {
  return useContext(FileLinkContext)
}
