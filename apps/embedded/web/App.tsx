import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, type Doc, type UiIntent, type User } from './api.ts'
import { AgentSidebar } from './components/AgentSidebar.tsx'
import { DocEditor } from './components/DocEditor.tsx'
import { DocList } from './components/DocList.tsx'
import { LoginView } from './components/LoginView.tsx'

/**
 * Documents on the left, the open one in the middle, the agent on the right.
 *
 * The app deliberately holds no agent state beyond "which session is showing" —
 * the transcript, the connection and the approvals all live inside
 * `SessionPanel`, and the sessions themselves live in the gateway.
 */
export function App() {
  const [user, setUser] = useState<User | null | undefined>()
  const [docs, setDocs] = useState<Doc[]>([])
  const [openId, setOpenId] = useState<string | undefined>()
  const [openDoc, setOpenDoc] = useState<Doc | undefined>()

  useEffect(() => {
    api.me().then((r) => setUser(r.user)).catch(() => setUser(null))
  }, [])

  const loadDocs = useCallback(async () => {
    if (!user) return
    const list = await api.listDocs().catch(() => [])
    setDocs(list)
    setOpenId((current) => current ?? list[0]?.id)
  }, [user])

  useEffect(() => {
    void loadDocs()
  }, [loadDocs])

  const loadOpenDoc = useCallback(async () => {
    if (!openId) {
      setOpenDoc(undefined)
      return
    }
    try {
      setOpenDoc(await api.getDoc(openId))
    } catch (e) {
      // The agent (or another tab) may have deleted it out from under us.
      if (e instanceof ApiError && e.status === 404) {
        setOpenId(undefined)
        setOpenDoc(undefined)
      }
    }
  }, [openId])

  useEffect(() => {
    void loadOpenDoc()
  }, [loadOpenDoc])

  /** The agent finished a turn — it may have written something. */
  const refreshFromAgent = useCallback(() => {
    void loadDocs()
    void loadOpenDoc()
  }, [loadDocs, loadOpenDoc])

  // Push what is on screen up to the server, so the agent's `whoami` can answer
  // "the document I'm looking at" without being able to see the screen.
  useEffect(() => {
    if (!user) return
    void api.setUiState(openId).catch(() => {})
  }, [user, openId])

  // …and take navigation the other way. `EventSource` handles its own
  // reconnect, which is most of why this is SSE rather than a second socket.
  useEffect(() => {
    if (!user) return
    const source = new EventSource('/api/ui-events')
    source.onmessage = (event) => {
      const intent = JSON.parse(event.data) as UiIntent
      if (intent.type === 'open_doc') {
        setOpenId(intent.docId)
        // The agent usually created or edited it in the same turn, so the list
        // is stale by exactly this document.
        void loadDocs()
      } else if (intent.type === 'doc_deleted') {
        // Clear the editor first. Leaving a deleted document on screen invites
        // an edit-and-save against an id that no longer exists, which would 404
        // and read as the app being broken rather than as the document being
        // gone. `loadDocs` then picks the next one, as it does at startup.
        setOpenId((current) => (current === intent.docId ? undefined : current))
        setOpenDoc((current) => (current?.id === intent.docId ? undefined : current))
        void loadDocs()
      }
    }
    return () => source.close()
  }, [user, loadDocs])

  if (user === undefined) return <div className='h-full bg-bg' />
  if (user === null) return <LoginView onSignedIn={setUser} />

  const createDoc = async () => {
    const doc = await api.createDoc('Untitled')
    await loadDocs()
    setOpenId(doc.id)
  }

  const signOut = async () => {
    await api.logout()
    setUser(null)
    setDocs([])
    setOpenId(undefined)
    setOpenDoc(undefined)
  }

  return (
    <div className='flex h-full w-full overflow-hidden bg-bg text-text'>
      <DocList
        docs={docs}
        selectedId={openId}
        user={user}
        onSelect={setOpenId}
        onCreate={() => void createDoc()}
        onRename={(id, title) => {
          void api.updateDoc(id, { title }).then(loadDocs).then(loadOpenDoc)
        }}
        onSignOut={() => void signOut()}
      />

      {openDoc ? (
        <DocEditor
          doc={openDoc}
          onSave={async (patch) => {
            const saved = await api.updateDoc(openDoc.id, patch)
            // The editor and this both adopt the same server record, so the
            // next render carries no stale copy for the editor to "restore".
            setOpenDoc(saved)
            await loadDocs()
            return saved
          }}
          onReload={() => void loadOpenDoc()}
        />
      ) : (
        <section className='flex flex-1 items-center justify-center bg-bg'>
          <p className='text-sm text-fg-3'>
            {docs.length === 0 ? 'Create a document to get started.' : 'Pick a document.'}
          </p>
        </section>
      )}

      <AgentSidebar onWikiMaybeChanged={refreshFromAgent} />
    </div>
  )
}
