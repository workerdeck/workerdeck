import { randomBytes } from 'node:crypto'
import { createAction, createContext, notFound, badRequest } from '@silkweave/core'
import { AUTH_REQUEST_KEY, mcpTransport } from '@silkweave/mcp/server'
import express, { type RequestHandler } from 'express'
import z from 'zod/v4'
import type { AppState } from './app-state.ts'
import type { WikiDb } from './db.ts'
import type { User } from './shared.ts'

/**
 * The wiki, exposed to the agent as a real MCP server over streamable HTTP.
 *
 * It would have been cheaper to hand `createEngineSession` a plain `ToolSet` —
 * the option takes one, and the agent could not tell the difference. This goes
 * over the wire on purpose: it is the seam an embedder actually has (their tools
 * are usually already an MCP server, or want to be reachable by other clients
 * too), and putting a real transport in the reference implementation is what
 * makes it a reference rather than a shortcut.
 *
 * **Identity does not come from the model.** Every tool acts as one user, and
 * which user is decided by the bearer token on the HTTP request — minted per
 * agent session by {@link WikiMcp.issueToken} and known only to the gateway
 * process. A tool never takes a `userId` argument, because an argument is
 * something the model can choose and this is not the model's choice to make.
 */

type AuthInfo = { token: string; userId: string }

const userOf = (context: { get: <T>(key: string) => T }): string =>
  context.get<AuthInfo>('auth').userId

const docSummary = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
})

export function createWikiActions(db: WikiDb) {
  const listDocs = createAction({
    name: 'list_docs',
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
    description:
      'Read one wiki document by id or by exact title. Returns its full body. Prefer id when ' +
      'you have one — titles are not unique.',
    input: z.object({
      id: z.string().optional().describe('Document id, as returned by list_docs.'),
      title: z.string().optional().describe('Exact title, case-insensitive. Used only when id is absent.'),
    }),
    output: z.object({ id: z.string(), title: z.string(), body: z.string(), updatedAt: z.number() }),
    annotations: { readOnlyHint: true },
    run: async ({ id, title }, context) => {
      const userId = userOf(context)
      if (!id && !title) throw badRequest('pass either id or title')
      // Same empty-string tolerance as write_doc.
      const doc = id ? db.getDoc(userId, id) : db.findDocByTitle(userId, title!)
      if (!doc) throw notFound(`no such document: ${id || title}`)
      return { id: doc.id, title: doc.title, body: doc.body ?? '', updatedAt: doc.updatedAt }
    },
  })

  const writeDoc = createAction({
    name: 'write_doc',
    description:
      'Create a document, or replace the body of an existing one. Pass id to overwrite that ' +
      'document; pass only title to create a new one. The body is replaced wholesale, not ' +
      'appended — read_doc first if you mean to edit.',
    input: z.object({
      id: z.string().optional().describe('Existing document to overwrite. Omit to create.'),
      title: z.string().optional().describe('Title for a new document, or a rename of an existing one.'),
      body: z.string().describe('The full new body, in Markdown.'),
    }),
    output: docSummary,
    annotations: { readOnlyHint: false, destructiveHint: true },
    run: async ({ id, title, body }, context) => {
      const userId = userOf(context)
      // Empty string, not just absent: a model asked to omit an optional field
      // routinely sends `""` instead, and reading that as "overwrite document
      // ''" would be a confusing not-found where a create was meant. Observed
      // on the first real run, not hypothesised.
      if (id) {
        const updated = db.updateDoc(userId, id, { title, body })
        if (!updated) throw notFound(`no such document: ${id}`)
        return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt }
      }
      if (!title) throw badRequest('pass a title when creating a document')
      const created = db.createDoc(userId, title, body)
      return { id: created.id, title: created.title, updatedAt: created.updatedAt }
    },
  })

  const renameDoc = createAction({
    name: 'rename_doc',
    description: 'Change a document’s title, leaving its body untouched.',
    input: z.object({ id: z.string(), title: z.string() }),
    output: docSummary,
    annotations: { readOnlyHint: false },
    run: async ({ id, title }, context) => {
      const updated = db.updateDoc(userOf(context), id, { title })
      if (!updated) throw notFound(`no such document: ${id}`)
      return { id: updated.id, title: updated.title, updatedAt: updated.updatedAt }
    },
  })

  return [listDocs, readDoc, writeDoc, renameDoc]
}

/**
 * Delete, kept apart from the rest because it is the one irreversible thing in
 * here and it needs the navigation channel.
 *
 * **It takes an id and nothing else.** Every other tool accepts a title as a
 * fallback; this one must not, because the title lookup is case-insensitive and
 * returns the first of any duplicates — a resolution rule that is a convenience
 * for reading and a way to destroy the wrong document for deleting. The model
 * resolves the title with `list_docs` first, which also puts the id it is about
 * to delete into the transcript where the user can see it.
 *
 * Note what is *not* available: a confirmation prompt. The provider engine's
 * capability record says `interactiveApprovals: false`, so there is no approval
 * channel to gate this behind — the honest options are to grant it or not, and
 * an app with more to lose than a demo wiki should think about which.
 */
export function createDeleteAction(db: WikiDb, state: AppState) {
  return createAction({
    name: 'delete_doc',
    description:
      'Permanently delete a wiki document. This cannot be undone and there is no confirmation ' +
      'step — do not call it unless the user has clearly asked for that document to be deleted. ' +
      'Takes an id only: resolve a title with list_docs first, and say which document you are ' +
      'about to delete before you do it.',
    input: z.object({ id: z.string().describe('Document id, from list_docs. Titles are not accepted.') }),
    output: z.object({ id: z.string(), title: z.string(), deleted: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async ({ id }, context) => {
      const userId = userOf(context)
      // Read first, so the answer can name what went — and so another user's id
      // is a plain not-found rather than a delete that reports zero rows.
      const doc = db.getDoc(userId, id)
      if (!doc) throw notFound(`no such document: ${id}`)
      db.deleteDoc(userId, id)
      // If it was the one on screen, the user is now looking at a document that
      // does not exist. Clear the record and tell the tab, rather than leaving
      // it to notice on its next fetch.
      if (state.get(userId).openDocId === id) {
        state.set(userId, { ...state.get(userId), openDocId: undefined })
      }
      state.dispatch(userId, { type: 'doc_deleted', docId: id })
      return { id, title: doc.title, deleted: true }
    },
  })
}

/**
 * The tools that make the agent aware of the app rather than only of its data:
 * who it is talking to, what is on their screen, and how to move them.
 *
 * Both are still per-user by the same token, so "the document I'm looking at"
 * can only ever mean the caller's own.
 */
export function createAppActions(db: WikiDb, state: AppState, users: readonly User[]) {
  const whoAmI = createAction({
    name: 'whoami',
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
    run: async ({ id, title }, context) => {
      const userId = userOf(context)
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

export type WikiMcp = {
  /** Mountable handler for `POST <path>` — hand it to the host's router. */
  handler: RequestHandler
  /**
   * Mint a bearer token that makes MCP calls act as `userId`. One per agent
   * session, revoked when the session's runner is disposed.
   */
  issueToken(userId: string): { token: string; revoke: () => void }
}

/**
 * Build the MCP endpoint. Not a server of its own: `mcpTransport` hands back a
 * plain Express handler, which the host mounts on its own port — one origin for
 * the SPA, the gateway and this, which is what lets the browser's cookie
 * authenticate a WebSocket upgrade at all.
 */
export function createWikiMcp(db: WikiDb, state: AppState, users: readonly User[]): WikiMcp {
  const tokens = new Map<string, string>()

  const transport = mcpTransport(
    {
      name: 'wiki',
      description:
        'The signed-in user’s wiki — list, read, write and rename documents — plus who they are, ' +
        'what they have open, and how to navigate them to a document.',
      version: '1.0.0',
      // The action linter warns about description length on startup; the
      // descriptions here are written for the model, not for it.
      lint: false,
    },
    createContext({ adapter: 'http' }),
    [...createWikiActions(db), createDeleteAction(db, state), ...createAppActions(db, state, users)],
  )

  const authenticate: RequestHandler = (req, res, next) => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const userId = tokens.get(token)
    if (!userId) {
      // The tokens are internal to this process and never leave it, so a request
      // without one is a bug or a probe, not a user-facing state.
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    // Silkweave forks whatever is on this key into the per-request context, and
    // `registerTools` inherits it — which is how a tool handler learns who it is
    // acting as without an AsyncLocalStorage and without a tool argument.
    ;(req as unknown as Record<string, AuthInfo>)[AUTH_REQUEST_KEY] = { token, userId }
    next()
  }

  const router = express.Router()
  router.post('/', express.json({ limit: '4mb' }), authenticate, transport.post)
  // Silkweave's transport is stateless — one request/response per call, with no
  // standing server→client stream — so there is no `GET` to serve. It has to say
  // so in the spec's words: a client opens the SSE stream on GET, and MCP
  // requires **405** from a server that does not offer one. Left to Express's
  // default 404 the client reads "wrong endpoint" and the whole connect fails,
  // which is exactly what happened the first time this ran.
  router.all('/', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'method not allowed' })
  })

  return {
    handler: router,
    issueToken(userId) {
      const token = randomBytes(24).toString('base64url')
      tokens.set(token, userId)
      return { token, revoke: () => tokens.delete(token) }
    },
  }
}
