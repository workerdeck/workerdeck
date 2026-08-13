import { useState } from 'react'
import type { Doc, User } from '../lib/api.ts'

export type DocListProps = {
  docs: Doc[]
  selectedId?: string
  user: User
  onSelect: (id: string) => void
  onCreate: () => void
  onRename: (id: string, title: string) => void
  onSignOut: () => void
}

/**
 * The left rail: the signed-in user's documents, flat and newest-first.
 *
 * Rename is a double-click on the title — a single click navigates, so the first
 * click of a double-click would otherwise have already left the row.
 */
export function DocList({
  docs,
  selectedId,
  user,
  onSelect,
  onCreate,
  onRename,
  onSignOut,
}: DocListProps) {
  const [editing, setEditing] = useState<string | undefined>()

  return (
    <aside className='flex h-full w-64 shrink-0 flex-col border-r border-border bg-sidebar'>
      <header className='flex items-center justify-between px-3 py-2.5'>
        <span className='text-xs font-semibold uppercase tracking-wide text-fg-3'>Documents</span>
        <button
          type='button'
          onClick={onCreate}
          title='New document'
          aria-label='New document'
          className='rounded px-1.5 text-base leading-none text-fg-3 hover:bg-row-hover hover:text-fg-1'
        >
          +
        </button>
      </header>

      <div className='flex-1 overflow-y-auto'>
        {docs.length === 0 && (
          <p className='px-3 py-6 text-center text-xs text-fg-3'>
            No documents yet. Use <span className='text-fg-2'>+</span> above, or ask the agent to
            write one.
          </p>
        )}
        {docs.map((doc) => {
          const selected = doc.id === selectedId
          return (
            <div
              key={doc.id}
              className={`relative flex items-center px-2 py-0.5 ${selected ? 'before:absolute before:inset-y-0.5 before:left-0 before:w-[3px] before:rounded-r before:bg-accent' : ''}`}
            >
              {editing === doc.id ? (
                <input
                  autoFocus
                  defaultValue={doc.title}
                  onBlur={(e) => {
                    setEditing(undefined)
                    const next = e.target.value.trim()
                    if (next && next !== doc.title) onRename(doc.id, next)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') {
                      e.currentTarget.value = doc.title
                      e.currentTarget.blur()
                    }
                  }}
                  className='w-full rounded border border-accent bg-surface px-2 py-1 text-sm text-fg-1 outline-none'
                />
              ) : (
                <button
                  type='button'
                  onClick={() => onSelect(doc.id)}
                  onDoubleClick={() => setEditing(doc.id)}
                  title='Double-click to rename'
                  className={`w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-row-hover ${
                    selected ? 'text-fg-1' : 'text-fg-2'
                  }`}
                >
                  {doc.title}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <footer className='flex items-center gap-2 border-t border-border px-3 py-2'>
        <span aria-hidden>{user.avatar}</span>
        <span className='flex-1 truncate text-xs text-fg-2'>{user.name}</span>
        <button
          type='button'
          onClick={onSignOut}
          className='rounded px-1.5 py-0.5 text-xs text-fg-3 hover:bg-row-hover hover:text-fg-1'
        >
          Sign out
        </button>
      </footer>
    </aside>
  )
}
