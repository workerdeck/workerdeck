import type { User } from '../shared.ts'

/**
 * A demo login with no passwords. This is the file to **delete** when you swap in
 * real authentication; `cookie.ts` beside it is not — everything downstream deals
 * only in a resolved `User`.
 */
export const USERS: readonly User[] = [
  { id: 'ada', name: 'Ada Lovelace', avatar: '🧮' },
  { id: 'grace', name: 'Grace Hopper', avatar: '🐛' },
  { id: 'alan', name: 'Alan Turing', avatar: '🧩' },
]

export const userById = (id: string | undefined): User | undefined => USERS.find((u) => u.id === id)
