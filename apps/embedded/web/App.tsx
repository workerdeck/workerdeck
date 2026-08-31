import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UiIntent, type User } from './lib/api.ts'
import { isNotFound, trpc } from './lib/trpc.ts'
import { AgentSidebar } from './components/AgentSidebar.tsx'
import { DocEditor } from './components/DocEditor.tsx'
import { DocList } from './components/DocList.tsx'
import { LoginView } from './components/LoginView.tsx'

export function App() {
  const [user, setUser] = useState<User | null | undefined>()
  const [openId, setOpenId] = useState<string | undefined>()
  const queryClient = useQueryClient()

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
  }, [])

  const docs = useQuery({ ...trpc.listDocs.queryOptions({}), enabled: Boolean(user) })
  const docList = docs.data?.docs ?? []

  const openDoc = useQuery({
    ...trpc.readDoc.queryOptions({ id: openId ?? '' }),
    enabled: Boolean(user && openId),
  })

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries()
  }, [queryClient])

  const createDoc = useMutation(trpc.createDoc.mutationOptions({ onSuccess: refresh }))
  const updateDoc = useMutation(trpc.updateDoc.mutationOptions({ onSuccess: refresh }))
  const renameDoc = useMutation(trpc.renameDoc.mutationOptions({ onSuccess: refresh }))

  useEffect(() => {
    if (!openId && docList.length > 0) {
      setOpenId(docList[0]!.id)
    }
  }, [openId, docList])

  useEffect(() => {
    if (openDoc.error && isNotFound(openDoc.error)) {
      setOpenId(undefined)
    }
  }, [openDoc.error])

  useEffect(() => {
    if (!user) {
      return
    }
    void api.setUiState(openId).catch(() => {})
  }, [user, openId])

  useEffect(() => {
    if (!user) {
      return
    }
    const source = new EventSource('/api/ui-events')
    source.onmessage = (event) => {
      const intent = JSON.parse(event.data) as UiIntent
      if (intent.type === 'open_doc') {
        setOpenId(intent.docId)
        refresh()
      } else if (intent.type === 'doc_deleted') {
        setOpenId((current) => (current === intent.docId ? undefined : current))
        refresh()
      }
    }
    return () => source.close()
  }, [user, refresh])

  if (user === undefined) {
    return <div className="h-full bg-bg" />
  }
  if (user === null) {
    return <LoginView onSignedIn={setUser} />
  }

  const newDoc = async () => {
    const doc = await createDoc.mutateAsync({ title: 'Untitled', body: '' })
    setOpenId(doc.id)
  }

  const signOut = async () => {
    await api.logout()
    setUser(null)
    setOpenId(undefined)
    // The next user must not see this one's documents in a warm cache.
    queryClient.clear()
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-text">
      <DocList
        docs={docList}
        selectedId={openId}
        user={user}
        onSelect={setOpenId}
        onCreate={() => void newDoc()}
        onRename={(id, title) => {
          renameDoc.mutate({ id, title })
        }}
        onSignOut={() => void signOut()}
      />

      {openDoc.data ? (
        <DocEditor
          doc={openDoc.data}
          onSave={async (patch) => {
            await updateDoc.mutateAsync({
              id: openDoc.data.id,
              title: patch.title,
              body: patch.body ?? openDoc.data.body,
            })
            const fresh = await queryClient.fetchQuery(trpc.readDoc.queryOptions({ id: openDoc.data.id }))
            return fresh
          }}
          onReload={() => void openDoc.refetch()}
        />
      ) : (
        <section className="flex flex-1 items-center justify-center bg-bg">
          <p className="text-sm text-fg-3">{docList.length === 0 ? 'Create a document to get started.' : 'Pick a document.'}</p>
        </section>
      )}

      <AgentSidebar onWikiMaybeChanged={refresh} />
    </div>
  )
}
