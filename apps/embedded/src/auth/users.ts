import type { User } from '../shared.ts'

// A demo login with no passwords: this is the file to delete when swapping in real auth, and `cookie.ts` is not.
export const USERS: readonly User[] = [
  { id: 'ada', name: 'Ada Lovelace', avatar: '🧮' },
  { id: 'grace', name: 'Grace Hopper', avatar: '🐛' },
  { id: 'alan', name: 'Alan Turing', avatar: '🧩' },
]

export const userById = (id: string | undefined): User | undefined => USERS.find((u) => u.id === id)
