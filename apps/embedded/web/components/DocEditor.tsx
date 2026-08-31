import { useEffect, useRef, useState } from 'react'
import type { Doc } from '../lib/api.ts'

export type DocEditorProps = {
  doc: Doc
  // Must resolve with the document the server now holds — see `save` below.
  onSave: (patch: { title?: string; body?: string }) => Promise<Doc>
  onReload: () => void
}

// The agent can write this document while it is open, so the loaded copy and the draft are kept apart.
export function DocEditor({ doc, onSave, onReload }: DocEditorProps) {
  const [title, setTitle] = useState(doc.title)
  const [body, setBody] = useState(doc.body ?? '')
  const [saving, setSaving] = useState(false)
  // What the server last told us this document was, compared against the props to spot a write from elsewhere.
  const known = useRef({ id: doc.id, title: doc.title, body: doc.body ?? '' })
  const dirty = title !== known.current.title || body !== known.current.body

  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    const incoming = { id: doc.id, title: doc.title, body: doc.body ?? '' }
    if (incoming.id !== known.current.id) {
      known.current = incoming
      setTitle(incoming.title)
      setBody(incoming.body)
      setConflict(false)
      return
    }
    const changedOnServer = incoming.title !== known.current.title || incoming.body !== known.current.body
    if (!changedOnServer) {
      return
    }
    known.current = incoming
    if (dirty) {
      setConflict(true)
      return
    }
    setTitle(incoming.title)
    setBody(incoming.body)
  }, [doc, dirty])

  const save = async () => {
    setSaving(true)
    try {
      // Adopt the server's answer, not what was sent: the next render still carries the pre-save `doc` prop, which the
      // effect above would read as "the agent changed it" and restore over the save that just succeeded.
      const saved = await onSave({ title: title.trim() || 'Untitled', body })
      known.current = { id: saved.id, title: saved.title, body: saved.body ?? '' }
      setTitle(saved.title)
      setBody(saved.body ?? '')
      setConflict(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled"
          className="min-w-0 flex-1 bg-transparent text-base font-medium text-fg-1 outline-none placeholder:text-fg-4"
        />
        {dirty && <span className="text-xs text-fg-3">unsaved</span>}
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:bg-accent-hover disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {conflict && (
        <div className="flex items-center gap-3 border-b border-border bg-warning-bg px-4 py-2 text-xs text-fg-1">
          <span className="flex-1">The agent changed this document while you were editing. Your draft is untouched.</span>
          <button
            type="button"
            onClick={() => {
              setTitle(known.current.title)
              setBody(known.current.body)
              setConflict(false)
            }}
            className="rounded border border-border px-2 py-0.5 hover:bg-row-hover"
          >
            Load theirs
          </button>
          <button type="button" onClick={() => setConflict(false)} className="rounded border border-border px-2 py-0.5 hover:bg-row-hover">
            Keep mine
          </button>
          <button type="button" onClick={onReload} className="rounded px-2 py-0.5 text-fg-3 hover:bg-row-hover hover:text-fg-1">
            Refresh
          </button>
        </div>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
        placeholder="Write something, or ask the agent on the right to draft it."
        className="flex-1 resize-none bg-transparent px-4 py-3 font-mono text-sm leading-relaxed text-fg-1 outline-none placeholder:text-fg-4"
      />
    </section>
  )
}
