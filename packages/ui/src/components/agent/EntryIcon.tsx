import { File, Folder, Link2 } from 'lucide-react'
import type { HostDirEntry } from '@workerdeck/protocol'

// The icon for one host directory entry. A symlink is drawn as a link and never silently
// resolved — the caller decides what a symlink means, the tree only says it is one.
export function EntryIcon({ type }: { type: HostDirEntry['type'] }) {
  if (type === 'dir') {
    return <Folder className="size-3.5 shrink-0 text-accent" />
  }
  if (type === 'symlink') {
    return <Link2 className="size-3.5 shrink-0 text-fg-4" />
  }
  return <File className="size-3.5 shrink-0 text-fg-4" />
}
