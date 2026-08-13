import { createAction, badRequest, notFound } from '@silkweave/core'
import z from 'zod/v4'
import type { AppState } from './app-state.ts'
import type { WikiDb } from './db.ts'
import type { User } from './shared.ts'

/**
 * The wiki's operations, written **once**, as silkweave actions.
 *
 * This file is the point of the whole app. Each action is a name, a schema and a
 * function; two adapters project them onto two transports:
 *
 * - `wiki-mcp.ts` → MCP over HTTP, for the **agent**, authenticated by a bearer
 *   token minted per session and never seen by the model.
 * - `wiki-api.ts` → tRPC over the same origin, for the **SPA**, authenticated by
 *   the app's own login cookie.
 *
 * They were two implementations before — `update_doc` and `PATCH /api/docs/:id`
 * being two spellings of one operation — which is survivable at six operations
 * and is the entire maintenance cost of the product at fifty. An app whose
 * browser and whose agent act on the same domain has this shape whether or not
 * it admits it.
 *
 * **Identity never comes from the caller's input.** Every action reads its user
 * from `context.get('auth')`, which each adapter resolves its own way and lands
 * on the same key. No action takes a `userId` argument, because an argument is
 * something the model can choose.
 *
 * `kind: 'query'` on the read-only ones is what makes them tRPC *queries* (and
 * therefore cacheable by react-query) rather than mutations; `readOnlyHint` is
 * the same fact told to an agent. Both are worth setting.
 */

type AuthInfo = { token: string; userId: string }

const userOf = (context: { get: <T>(key: string) => T }): string =>
  context.get<AuthInfo>('auth').userId

/**
 * Treat a blank optional string as absent.
 *
 * A model asked to omit an optional field frequently sends *something* instead:
 * `""`, and — observed live, which is how this function came to exist — `" "`, a
 * single space. Some providers make it worse by rewriting a tool's schema so
 * every property is required, at which point the model has no way to omit
 * anything and must invent a filler value.
 *
 * So no optional string is trusted as given. This is the one normalization, at
 * the one boundary, rather than a `.min(1)` on each schema — which is what was
 * here before and which a single space walks straight through, because its
 * length is 1.
 */
const text = (value: string | undefined): string | undefined => {
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

/**
 * The CRUD core: the operations the SPA and the agent both perform, in the same
 * way, on the same rows. This is the set both adapters get.
 *
 * The descriptions read as if written for the model because they were — they
 * cost the SPA nothing, and a tool description is prompt rather than
 * documentation. What is *not* shared is anything where the two callers want
 * different semantics; see below.
 */
export function createWikiActions(db: WikiDb, state: AppState) {
  const listDocs = createAction({
    name: 'list_docs',
    kind: 'query',
    description:
      "List every document in the current user's wiki, newest first. Returns ids and titles; " +
      'use read_doc to get a body.',
    input: z.object({}),
    output: z.object({ docs: z.array(docSummary) }),
    annotations: { readOnlyHint: true },
    run: async (_input, context) => ({ docs: db.listDocs(userOf(context)) }),
  })

  const readDoc = createAction({
    name: 'read_doc',
    kind: 'query',
    description:
      'Read one wiki document by id or by exact title. Returns its full body. Prefer id when ' +
      'you have one — titles are not unique.',
    input: z.object({
      id: z.string().optional().describe('Document id, as returned by list_docs.'),
      title: z
        .string()
        .optional()
        .describe('Exact title, case-insensitive. Used only when id is absent.'),
    }),
    output: docBody,
    annotations: { readOnlyHint: true },
    run: async (input, context) => {
      const userId = userOf(context)
      // Normalized, not trusted: `id: " "` would otherwise select the id branch
      // and turn a perfectly good title lookup into a not-found.
      const id = text(input.id)
      const title = text(input.title)
      if (!id && !title) throw badRequest('pass either id or title')
      const doc = id ? db.getDoc(userId, id) : db.findDocByTitle(userId, title!)
      if (!doc) throw notFound(`no such document: ${id || title}`)
      return { id: doc.id, title: doc.title, body: doc.body ?? '', updatedAt: doc.updatedAt }
    },
  })

  /**
   * Create and update are **two actions**, and that is the fix for a real bug.
   *
   * They were one `write_doc` whose behaviour turned on whether an optional `id`
   * was present — create when absent, overwrite when given. A model that cannot
   * omit the field (see {@link text}) sent `" "`, which is truthy, so every
   * attempt to create a document tried to overwrite a document called `" "` and
   * failed with "no such document". Twenty times, in the transcript that found
   * this.
   *
   * No amount of schema tightening fixes that shape, because the tool asks the
   * model to express an intent by *withholding* a value, and withholding is the
   * one thing a model is unreliable at. Two tools with required arguments state
   * the intent in the name, where it cannot be lost.
   */
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
      if (!clean) throw badRequest('pass a title when creating a document')
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
      if (!id) throw badRequest('pass the id of the document to update')
      // A blank title is "leave it alone", never a rename to nothing.
      const updated = db.updateDoc(userOf(context), id, { title: text(input.title), body: input.body })
      if (!updated) throw notFound(`no such document: ${id}`)
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
      if (!id || !title) throw badRequest('pass both an id and a non-empty title')
      const updated = db.updateDoc(userOf(context), id, { title })
      if (!updated) throw notFound(`no such document: ${id}`)
      return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt }
    },
  })

  /**
   * Delete: shared, but the one that deserved the most thought.
   *
   * **It takes an id and nothing else**, unlike `read_doc` which accepts a title
   * fallback. The title lookup is case-insensitive and returns the first of any
   * duplicates — a resolution rule that is a convenience for reading and a way to
   * destroy the wrong document for deleting. The agent must resolve it with
   * `list_docs` first, which also puts the id it is about to delete into the
   * transcript where the user can see it. The SPA always has an id anyway.
   *
   * Note what is *not* available: a confirmation prompt. The provider engine's
   * capability record says `interactiveApprovals: false`, so there is no approval
   * channel to gate this behind — the honest options are to grant it or not, and
   * an app with more to lose than a demo wiki should think about which.
   */
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
      if (!id) throw badRequest('pass the id of the document to delete')
      // Read first, so the answer can name what went — and so another user's id
      // is a plain not-found rather than a delete that reports zero rows.
      const doc = db.getDoc(userId, id)
      if (!doc) throw notFound(`no such document: ${id}`)
      db.deleteDoc(userId, id)
      // If it was the one on screen, the user is now looking at a document that
      // does not exist. Clear the record and tell the tab, rather than leaving
      // it to notice on its next fetch. True whichever caller deleted it — which
      // is exactly the kind of thing that used to be in one copy and not the other.
      if (state.get(userId).openDocId === id) {
        state.set(userId, { ...state.get(userId), openDocId: undefined })
      }
      state.dispatch(userId, { type: 'doc_deleted', docId: id })
      return { id, title: doc.title, deleted: true }
    },
  })

  // `as const` so the tuple keeps each action's literal `name`, which is what
  // lets `InferTrpcRouter` give the SPA a precisely-typed router rather than a
  // union of every procedure.
  return [listDocs, readDoc, createDoc, updateDoc, renameDoc, deleteDoc] as const
}

/**
 * Agent-only: the actions that make the loop aware of the *app* rather than only
 * of its data — who it is talking to, what is on their screen, how to move them.
 *
 * Deliberately not on the tRPC router. The SPA knows which document it is showing
 * (it is showing it) and navigates by calling its own router; exposing `open_doc`
 * to the tab would be a component asking a server to tell it what it already
 * decided. A shared action set is not the same as an identical one, and the line
 * falls exactly where the two callers genuinely differ.
 */
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
        // A doc the user had open and has since deleted resolves to null rather
        // than to a dangling id the model would then try to read.
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
      /** False when nothing was listening — see {@link AppState.dispatch}. */
      shown: z.boolean(),
    }),
    annotations: { readOnlyHint: false },
    run: async (input, context) => {
      const userId = userOf(context)
      const id = text(input.id)
      const title = text(input.title)
      if (!id && !title) throw badRequest('pass either id or title')
      const doc = id ? db.getDoc(userId, id) : db.findDocByTitle(userId, title!)
      if (!doc) throw notFound(`no such document: ${id || title}`)
      // Recorded either way: an agent working while the tab is closed should
      // still leave the user on the right document when they come back.
      state.set(userId, { ...state.get(userId), openDocId: doc.id })
      const reached = state.dispatch(userId, { type: 'open_doc', docId: doc.id })
      return { id: doc.id, title: doc.title, shown: reached > 0 }
    },
  })

  return [whoAmI, openDoc]
}
