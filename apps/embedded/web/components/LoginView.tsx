import { useEffect, useState } from 'react'
import { api, type User } from '../lib/api.ts'

/**
 * Pick one of three users. No password: this stands in for whatever real auth an
 * embedder already has, and everything downstream deals in a resolved user.
 */
export function LoginView({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [users, setUsers] = useState<User[]>([])
  const [busy, setBusy] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch((e: Error) => setError(e.message))
  }, [])

  const signIn = async (id: string) => {
    setBusy(id)
    setError(undefined)
    try {
      const { user } = await api.login(id)
      if (user) {
        onSignedIn(user)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-fg-1">Wiki</h1>
        <p className="mt-1 text-sm text-fg-3">
          A demo of an embedded agent. Pick a user — each has their own documents and their own agent sessions.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {users.map((user) => (
            <button
              key={user.id}
              type="button"
              disabled={busy !== undefined}
              onClick={() => void signIn(user.id)}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <span aria-hidden className="text-xl">
                {user.avatar}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium text-fg-1">{user.name}</span>
                <span className="block text-xs text-fg-3">{user.id}</span>
              </span>
              {busy === user.id && <span className="text-xs text-fg-3">signing in…</span>}
            </button>
          ))}
        </div>
        {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    </div>
  )
}
