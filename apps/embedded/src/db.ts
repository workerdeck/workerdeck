import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Doc } from './shared.ts'

/**
 * The wiki's storage: `node:sqlite`, so the reference app carries no database
 * dependency at all (Node 22.5+ ships it; 24 has it unflagged).
 *
 * `.embedded/` is **data, not build output**. Nothing automated may delete it:
 * `pnpm clean` removes `dist` only, and wiping the wiki is the separate,
 * explicit `pnpm reset`. This is not a hypothetical tidiness rule — the two were
 * once the same script, and it cost someone their documents.
 *
 * Every query takes a `userId` and every WHERE clause carries it. That is
 * deliberate duplication of the gateway's session scoping rather than a
 * substitute for it: the gateway decides who may *drive a session*, this decides
 * whose *documents* a tool call can reach, and an agent that talked its way into
 * the wrong tool arguments must still come up empty. Two independent checks on
 * two different questions is the whole reason both exist.
 */
export type WikiDb = {
  listDocs(userId: string): Doc[]
  getDoc(userId: string, id: string): Doc | undefined
  findDocByTitle(userId: string, title: string): Doc | undefined
  createDoc(userId: string, title: string, body?: string): Doc
  updateDoc(userId: string, id: string, patch: { title?: string; body?: string }): Doc | undefined
  deleteDoc(userId: string, id: string): boolean
  close(): void
}

type Row = { id: string; title: string; body: string; updated_at: number }

const toDoc = (row: Row, withBody: boolean): Doc => ({
  id: row.id,
  title: row.title,
  updatedAt: row.updated_at,
  ...(withBody ? { body: row.body } : {}),
})

export function openWikiDb(file: string): WikiDb {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL so the agent's writes and the SPA's reads do not block each other; both
  // arrive on the same process but not on the same tick.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_user ON docs (user_id, updated_at DESC);
  `)

  const list = db.prepare(
    'SELECT id, title, body, updated_at FROM docs WHERE user_id = ? ORDER BY updated_at DESC',
  )
  const get = db.prepare('SELECT id, title, body, updated_at FROM docs WHERE user_id = ? AND id = ?')
  // Case-insensitive so an agent told "the roadmap doc" finds `Roadmap`.
  const byTitle = db.prepare(
    'SELECT id, title, body, updated_at FROM docs WHERE user_id = ? AND lower(title) = lower(?) LIMIT 1',
  )
  const insert = db.prepare(
    'INSERT INTO docs (id, user_id, title, body, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
  const update = db.prepare('UPDATE docs SET title = ?, body = ?, updated_at = ? WHERE user_id = ? AND id = ?')
  const remove = db.prepare('DELETE FROM docs WHERE user_id = ? AND id = ?')

  return {
    listDocs: (userId) => (list.all(userId) as unknown as Row[]).map((row) => toDoc(row, false)),
    getDoc: (userId, id) => {
      const row = get.get(userId, id) as unknown as Row | undefined
      return row && toDoc(row, true)
    },
    findDocByTitle: (userId, title) => {
      const row = byTitle.get(userId, title) as unknown as Row | undefined
      return row && toDoc(row, true)
    },
    createDoc: (userId, title, body = '') => {
      const doc: Doc = { id: randomUUID(), title, body, updatedAt: Date.now() }
      insert.run(doc.id, userId, doc.title, body, doc.updatedAt)
      return doc
    },
    updateDoc: (userId, id, patch) => {
      const current = get.get(userId, id) as unknown as Row | undefined
      if (!current) return undefined
      const next: Row = {
        ...current,
        title: patch.title ?? current.title,
        body: patch.body ?? current.body,
        updated_at: Date.now(),
      }
      update.run(next.title, next.body, next.updated_at, userId, id)
      return toDoc(next, true)
    },
    deleteDoc: (userId, id) => remove.run(userId, id).changes > 0,
    close: () => db.close(),
  }
}
