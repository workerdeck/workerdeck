import { createAction, badRequest, notFound } from '@silkweave/core'
import z from 'zod/v4'
import type { AppState } from '../app/state.ts'
import type { WikiDb } from './db.ts'
import type { User } from '../shared.ts'

type AuthInfo = { token: string; userId: string }

function userOf(context: { get: <T>(key: string) => T }): string {
  return context.get<AuthInfo>('auth').userId
}

// A model asked to omit an optional field sends `""` or (observed live) `" "` instead. `.min(1)` is not the fix — a
// single space has length 1 — so no optional string is trusted as given.
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

const docSummary = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
})

const docBody = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.number(),
})

// The descriptions are written for the model — a tool description is prompt, not documentation.
export function createWikiActions(db: WikiDb, state: AppState) {
  const listDocs = createAction({
    name: 'list_docs',
    kind: 'query',
    description: "List every document in the current user's wiki, newest first. Returns ids and titles; " + 'use read_doc to get a body.',
    input: z.object({}),
    output: z.object({ docs: z.array(docSummary) }),
    annotations: { readOnlyHint: true },
    run: async (_input, context) => ({ docs: db.listDocs(userOf(context)) }),
  })

  const readDoc = createAction({
    name: 'read_doc',
    kind: 'query',
    description:
      'Read one wiki document by id or by exact title. Returns its full body. Prefer id when ' + 'you have one — titles are not unique.',
    input: z.object({
      id: z.string().optional().describe('Document id, as returned by list_docs.'),
      title: z.string().optional().describe('Exact title, case-insensitive. Used only when id is absent.'),
    }),
    output: docBody,
    annotations: { readOnlyHint: true },
    run: async (input, context) => {
      const userId = userOf(context)
      // `id: " "` would otherwise select the id branch and turn a good title lookup into a not-found.
      const id = text(input.id)
      const title = text(input.title)
      if (!id && !title) {
        throw badRequest('pass either id or title')
      }
      const doc = id ? db.getDoc(userId, id) : db.findDocByTitle(userId, title!)
      if (!doc) {
        throw notFound(`no such document: ${id || title}`)
      }
      return { id: doc.id, title: doc.title, body: doc.body ?? '', updatedAt: doc.updatedAt }
    },
  })

  const createDoc = createAction({
    name: 'create_doc',
    description:
      'Create a NEW wiki document and return its id. Use this whenever the user asks for a new ' +
      'document, note or page. It never overwrites: to change an existing document use ' +
      'update_doc, and to find its id use list_docs.',
    input: z.object({
      title: z.string().describe('Title for the new document.'),
      body: z.string().describe('The full body, in Markdown. Pass an empty string for none.'),
    }),
    output: docSummary,
    annotations: { readOnlyHint: false },
    run: async ({ title, body }, context) => {
      const clean = text(title)
      if (!clean) {
        throw badRequest('pass a title when creating a document')
      }
      const created = db.createDoc(userOf(context), clean, body)
      return { id: created.id, title: created.title, updatedAt: created.updatedAt }
    },
  })

  const updateDoc = createAction({
    name: 'update_doc',
    description:
      'Replace the body of an EXISTING document, and optionally its title. The body is replaced ' +
      'wholesale, not appended — read_doc first if you mean to edit rather than replace. Takes ' +
      'the id from list_docs; it cannot create, so use create_doc for a new document.',
    input: z.object({
      id: z.string().describe('Existing document id, from list_docs.'),
      body: z.string().describe('The full new body, in Markdown.'),
      title: z.string().optional().describe('New title. Omit to leave the title alone.'),
    }),
    output: docSummary,
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async (input, context) => {
      const id = text(input.id)
      if (!id) {
        throw badRequest('pass the id of the document to update')
      }
      // A blank title is "leave it alone", never a rename to nothing.
      const updated = db.updateDoc(userOf(context), id, { title: text(input.title), body: input.body })
      if (!updated) {
        throw notFound(`no such document: ${id}`)
      }
      return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt }
    },
  })

  const renameDoc = createAction({
    name: 'rename_doc',
    description: 'Change a document’s title, leaving its body untouched.',
    input: z.object({
      id: z.string().describe('Existing document id, from list_docs.'),
      title: z.string().describe('The new title.'),
    }),
    output: docSummary,
    annotations: { readOnlyHint: false },
    run: async (input, context) => {
      const id = text(input.id)
      const title = text(input.title)
      if (!id || !title) {
        throw badRequest('pass both an id and a non-empty title')
      }
      const updated = db.updateDoc(userOf(context), id, { title })
      if (!updated) {
        throw notFound(`no such document: ${id}`)
      }
      return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt }
    },
  })

  // Takes an id and nothing else, unlike `read_doc`: a case-insensitive title lookup returning the first of any
  // duplicates is a convenience for reading and a way to destroy the wrong document for deleting.
  const deleteDoc = createAction({
    name: 'delete_doc',
    description:
      'Permanently delete a wiki document. This cannot be undone and there is no confirmation ' +
      'step — do not call it unless the user has clearly asked for that document to be deleted. ' +
      'Takes an id only: resolve a title with list_docs first, and say which document you are ' +
      'about to delete before you do it.',
    input: z.object({
      id: z.string().describe('Document id, from list_docs. Titles are not accepted.'),
    }),
    output: z.object({ id: z.string(), title: z.string(), deleted: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (input, context) => {
      const userId = userOf(context)
      const id = text(input.id)
      if (!id) {
        throw badRequest('pass the id of the document to delete')
      }
      // Read first, so the answer can name what went and another user's id is a plain not-found, not zero rows.
      const doc = db.getDoc(userId, id)
      if (!doc) {
        throw notFound(`no such document: ${id}`)
      }
      db.deleteDoc(userId, id)
      if (state.get(userId).openDocId === id) {
        state.set(userId, { ...state.get(userId), openDocId: undefined })
      }
      state.dispatch(userId, { type: 'doc_deleted', docId: id })
      return { id, title: doc.title, deleted: true }
    },
  })

  // `as const` keeps each action's literal `name`, which is what lets `InferTrpcRouter` type the SPA's router.
  return [listDocs, readDoc, createDoc, updateDoc, renameDoc, deleteDoc] as const
}

export function createAgentActions(db: WikiDb, state: AppState, users: readonly User[]) {
  const whoAmI = createAction({
    name: 'whoami',
    kind: 'query',
    description:
      'Who you are talking to and what they currently have open in the app. Call this before ' +
      'acting on phrases like "this doc", "the one I\'m on", "my notes" — it is the only way to ' +
      'resolve them, and guessing produces edits to the wrong document.',
    input: z.object({}),
    output: z.object({
      userId: z.string(),
      name: z.string(),
      openDoc: z
        .object({ id: z.string(), title: z.string() })
        .nullable()
        .describe('The document on screen right now, or null if none is open.'),
      docCount: z.number(),
    }),
    annotations: { readOnlyHint: true },
    run: async (_input, context) => {
      const userId = userOf(context)
      const openId = state.get(userId).openDocId
      const open = openId ? db.getDoc(userId, openId) : undefined
      return {
        userId,
        name: users.find((u) => u.id === userId)?.name ?? userId,
        // A since-deleted doc resolves to null rather than a dangling id the model would then try to read.
        openDoc: open ? { id: open.id, title: open.title } : null,
        docCount: db.listDocs(userId).length,
      }
    },
  })

  const openDoc = createAction({
    name: 'open_doc',
    description:
      "Navigate the user's app to a document, by id or exact title, so it is on their screen. " +
      'Use it after creating something they asked for. This changes what the person sees — do ' +
      'not call it to read a document, use read_doc for that.',
    input: z.object({
      id: z.string().optional().describe('Document id. Preferred.'),
      title: z.string().optional().describe('Exact title, case-insensitive. Used when id is absent.'),
    }),
    output: z.object({
      id: z.string(),
      title: z.string(),
      // False when no tab was listening.
      shown: z.boolean(),
    }),
    annotations: { readOnlyHint: false },
    run: async (input, context) => {
      const userId = userOf(context)
      const id = text(input.id)
      const title = text(input.title)
      if (!id && !title) {
        throw badRequest('pass either id or title')
      }
      const doc = id ? db.getDoc(userId, id) : db.findDocByTitle(userId, title!)
      if (!doc) {
        throw notFound(`no such document: ${id || title}`)
      }
      // Recorded even with no tab listening: an agent working while the tab is closed still leaves the user in place.
      state.set(userId, { ...state.get(userId), openDocId: doc.id })
      const reached = state.dispatch(userId, { type: 'open_doc', docId: doc.id })
      return { id: doc.id, title: doc.title, shown: reached > 0 }
    },
  })

  return [whoAmI, openDoc]
}
