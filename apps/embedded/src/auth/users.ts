import type { User } from '../shared.ts'

// A demo login with no passwords: this is the file to delete when swapping in real auth, and `cookie.ts` is not.
export const USERS: readonly User[] = [
  { id: 'ada', name: 'Ada Lovelace', avatar: '🧮' },
  { id: 'grace', name: 'Grace Hopper', avatar: '🐛' },
  { id: 'alan', name: 'Alan Turing', avatar: '🧩' },
]

export function userById(id: string | undefined): User | undefined {
  return USERS.find((u) => u.id === id)
}
