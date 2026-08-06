/**
 * The two prompt tokens the CLI understands — `@file` and `/command` — found in
 * text that has already been sent.
 *
 * The mirror of the iOS client's `PromptTokens.scan`, and deliberately the same
 * rules: a message should read the same after sending as it did in the composer,
 * on either client. It lives here, beside the transcript reducer, for the same
 * reason its Swift twin lives in the kit rather than the app — every interesting
 * case is an edge (an `@` mid-word, an email address, a slash that is really an
 * absolute path), so it is the part that gets unit-tested.
 *
 * Only the finished-text half is here; the composer's completion is the
 * prompt-area's own trigger machinery.
 */
export type PromptToken = {
  kind: 'file' | 'command'
  /** Offsets into the scanned string, prefix included. */
  start: number
  end: number
  text: string
}

/** Characters a command name may contain after the slash. Deliberately excludes
 * `/`, so an absolute path pasted into a message (`/Users/me/…`) is not mistaken
 * for a command; `:` is in because namespaced skills (`dev:wrapup`) are spelled
 * that way. */
const COMMAND_BODY = /^[A-Za-z0-9\-_.:]+$/

/** Trailing punctuation that belongs to the sentence, not the token — so
 * "see @README.md." styles the path and leaves the period alone. */
const SENTENCE_TAIL = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'"])

/**
 * Every token in a sent message.
 *
 * Stricter than what a composer completes: a bare `@` is a token being typed, but
 * in a sent message it is just an at sign.
 */
export function scanPromptTokens(text: string): PromptToken[] {
  const tokens: PromptToken[] = []
  // Word starts: the beginning of the text, and every position after whitespace.
  const words = /\S+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null) {
    const word = match[0]
    const kind = word[0] === '@' ? 'file' : word[0] === '/' ? 'command' : undefined
    if (!kind) continue
    let end = match.index + word.length
    while (end > match.index && SENTENCE_TAIL.has(text[end - 1]!)) end--
    const body = text.slice(match.index + 1, end)
    if (!body) continue
    if (kind === 'command' && !COMMAND_BODY.test(body)) continue
    tokens.push({ kind, start: match.index, end, text: text.slice(match.index, end) })
  }
  return tokens
}
