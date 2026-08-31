/**
 * The two prompt tokens the CLI understands — `@file` and `/command` — in text already sent, and
 * the mirror of the iOS client's `PromptTokens.scan`: the rules must stay identical, or a message
 * reads differently on the two clients. The composer's completion is the prompt-area's own.
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
export const scanPromptTokens = (text: string): PromptToken[] => {
  const tokens: PromptToken[] = []
  // Word starts: the beginning of the text, and every position after whitespace.
  const words = /\S+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null) {
    const word = match[0]
    const kind = word[0] === '@' ? 'file' : word[0] === '/' ? 'command' : undefined
    if (!kind) {
      continue
    }
    let end = match.index + word.length
    while (end > match.index && SENTENCE_TAIL.has(text[end - 1]!)) {
      end--
    }
    const body = text.slice(match.index + 1, end)
    if (!body) {
      continue
    }
    if (kind === 'command' && !COMMAND_BODY.test(body)) {
      continue
    }
    tokens.push({ kind, start: match.index, end, text: text.slice(match.index, end) })
  }
  return tokens
}
