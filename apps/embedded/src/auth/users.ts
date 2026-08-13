import type { User } from '../shared.ts'

/**
 * Three users, in the source, with no passwords. This is a demo login: the point
 * of the app is the *embedding*, and a real one would put Supabase or an OIDC
 * provider here and change nothing downstream — everything after this file deals
 * in a resolved `User`.
 *
 * This file is the one to **delete** when you swap in real authentication.
 * `cookie.ts` beside it is not: the cookie, and the same-origin guard that makes
 * it safe, are the parts worth keeping whatever resolves the identity.
 */
export const USERS: readonly User[] = [
  { id: 'ada', name: 'Ada Lovelace', avatar: '🧮' },
  { id: 'grace', name: 'Grace Hopper', avatar: '🐛' },
  { id: 'alan', name: 'Alan Turing', avatar: '🧩' },
]

export const userById = (id: string | undefined): User | undefined =>
  USERS.find((u) => u.id === id)
