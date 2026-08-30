import { useCallback, useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { HostDirEntry, HostFileMatch } from '@workerdeck/protocol'
import { ChevronLeft, File, Folder, Link2, Search } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { CodeBlock } from '../ui/CodeBlock.tsx'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { Input } from '../ui/Input.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { formatBytes } from '../../lib/format.ts'

export interface HostFilesDialogProps {
  client: WorkerDeckClient
  /** The session's working directory — the browser is rooted here. */
  cwd: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Browse the project the session is working in.
 *
 * Deliberately rooted at the session's cwd rather than at the server's
 * `hostFiles.roots`: the roots are the *security* boundary (the server enforces
 * them on every request), but what someone wants while watching an agent is this
 * project's tree. Read-only — writing is a separate server opt-in and not
 * something a session viewer should be doing behind the agent's back.
 */
export function HostFilesDialog({ client, cwd, open, onOpenChange }: HostFilesDialogProps) {
  const [path, setPath] = useState<string | undefined>(cwd)
  const [entries, setEntries] = useState<HostDirEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<HostFileMatch[] | undefined>()
  const [file, setFile] = useState<{ path: string; content: string; bytes: number } | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const list = useCallback(
    async (target: string) => {
      setLoading(true)
      setError(undefined)
      try {
        const response = await client.listHostDir(target)
        setPath(response.path)
        setEntries(response.entries)
        setTruncated(response.truncated ?? false)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read that directory')
      } finally {
        setLoading(false)
      }
    },
    [client],
  )

  // Opening resets the browser to the session's directory. Navigation from here
  // is explicit (`list`) rather than an effect on `path`, so walking into a
  // folder is one request and not two.
  useEffect(() => {
    if (!open) {
      return
    }
    setFile(undefined)
    setQuery('')
    setMatches(undefined)
    setError(undefined)
    if (cwd) {
      void list(cwd)
    }
  }, [open, cwd, list])

  // Debounced, and only while there is something to search for; an empty box is
  // "show me the directory again", not "search for everything".
  useEffect(() => {
    if (!open || !cwd) {
      return
    }
    const q = query.trim()
    if (!q) {
      setMatches(undefined)
      return
    }
    const timer = setTimeout(() => {
      client
        .findHostFiles(cwd, q, 40)
        .then((response) => setMatches(response.matches))
        .catch(() => setMatches([]))
    }, 150)
    return () => clearTimeout(timer)
  }, [client, cwd, query, open])

  const openFile = async (target: string) => {
    setLoading(true)
    setError(undefined)
    try {
      const response = await client.readHostFile(target)
      setFile({
        path: response.path,
        bytes: response.bytes,
        content: response.encoding === 'utf8' ? response.content : '(binary file — not shown)',
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file')
    } finally {
      setLoading(false)
    }
  }

  const parent = path && cwd && path !== cwd ? path.slice(0, path.lastIndexOf('/')) || '/' : undefined
  const shown = matches ?? entries

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={file ? file.path.split('/').pop()! : 'Files'}
          description={file ? file.path : path}
          actions={
            file ? (
              <Button variant="ghost" size="xs" onClick={() => setFile(undefined)}>
                <ChevronLeft className="size-3.5" />
                Back
              </Button>
            ) : parent ? (
              <Button variant="ghost" size="xs" onClick={() => void list(parent)}>
                <ChevronLeft className="size-3.5" />
                Up
              </Button>
            ) : null
          }
        />
        <DialogBody className="flex flex-col gap-3">
          {error ? <div className="rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger">{error}</div> : null}

          {file ? (
            <>
              <p className="text-label text-fg-4">{formatBytes(file.bytes)}</p>
              <CodeBlock code={file.content} label={file.path.split('/').pop()} />
            </>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-4" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this project…"
                  className="pl-7"
                  spellCheck={false}
                />
              </div>
              {loading && shown.length === 0 ? (
                <div className="py-6 text-center">
                  <Spinner className="size-4 text-fg-4" />
                </div>
              ) : shown.length === 0 ? (
                <p className="py-6 text-center text-body-sm text-fg-4">{matches ? 'No matching files.' : 'This directory is empty.'}</p>
              ) : (
                <ul className="flex flex-col">
                  {matches
                    ? matches.map((match) => (
                        <li key={match.path}>
                          <button
                            type="button"
                            onClick={() => void openFile(match.path)}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
                          >
                            <File className="size-3.5 shrink-0 text-fg-4" />
                            <span className="min-w-0 flex-1 truncate font-mono text-label text-fg-1">{match.relative}</span>
                          </button>
                        </li>
                      ))
                    : entries.map((entry) => (
                        <li key={entry.path}>
                          <button
                            type="button"
                            onClick={() => (entry.type === 'dir' ? void list(entry.path) : void openFile(entry.path))}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hover"
                          >
                            <EntryIcon type={entry.type} />
                            <span className="min-w-0 flex-1 truncate font-mono text-label text-fg-1">
                              {entry.name}
                              {entry.type === 'dir' ? '/' : ''}
                            </span>
                            {entry.bytes !== undefined ? (
                              <span className="shrink-0 text-label text-fg-4">{formatBytes(entry.bytes)}</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                </ul>
              )}
              {truncated && !matches ? (
                <p className="text-label text-fg-4">More entries than the server will return — use the search box.</p>
              ) : null}
            </>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/** A symlink is reported as itself and never silently resolved — following it is
 * the next request's problem, and that request is refused if it escapes the roots. */
function EntryIcon({ type }: { type: HostDirEntry['type'] }) {
  if (type === 'dir') {
    return <Folder className="size-3.5 shrink-0 text-accent" />
  }
  if (type === 'symlink') {
    return <Link2 className="size-3.5 shrink-0 text-fg-4" />
  }
  return <File className="size-3.5 shrink-0 text-fg-4" />
}
