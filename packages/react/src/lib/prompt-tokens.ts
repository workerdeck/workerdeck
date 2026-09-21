import { PEER_MENTION_SIGIL, PROMPT_SENTENCE_TAIL, isPeerMentionBody, peerMentionKey } from '@workerdeck/protocol'

export type PromptToken = {
  kind: 'file' | 'command' | 'skill' | 'session'
  start: number
  end: number
  text: string
}

// `$name` is codex's skill mention and `#Name` is another session on the gateway; in both cases only
// a name this client knows is a token, so a dollar amount and a colour literal never badge. The
// session list is *live*, so a mention drawn today may draw plain once that peer is renamed - the
// characters never change, only the colour, which is why this does not break the rule that a
// transcript must read on replay as it did live (that rule binds substituting a name for an id).
export type PromptTokenOptions = {
  skills?: readonly string[]
  // Folded slugs (`peerMentionKey(peerMentionSlug(title, id))`), not display titles.
  sessions?: readonly string[]
}

// No `/`, so a pasted absolute path is not a command; `:` is in for namespaced skills (`dev:wrapup`).
const COMMAND_BODY = /^[A-Za-z0-9\-_.:]+$/

// The same set the gateway peels with, so one boundary answers for every sigil.
const SENTENCE_TAIL = PROMPT_SENTENCE_TAIL

export function scanPromptTokens(text: string, options?: PromptTokenOptions): PromptToken[] {
  const tokens: PromptToken[] = []
  const skills = options?.skills?.length ? new Set(options.skills) : undefined
  const sessions = options?.sessions?.length ? new Set(options.sessions) : undefined
  const words = /\S+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null) {
    const word = match[0]
    const kind =
      word[0] === '@'
        ? 'file'
        : word[0] === '/'
          ? 'command'
          : word[0] === '$' && skills
            ? 'skill'
            : word[0] === PEER_MENTION_SIGIL && sessions
              ? 'session'
              : undefined
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
    if (kind === 'skill' && !skills!.has(body)) {
      continue
    }
    if (kind === 'session' && !(isPeerMentionBody(body) && sessions!.has(peerMentionKey(body)))) {
      continue
    }
    tokens.push({ kind, start: match.index, end, text: text.slice(match.index, end) })
  }
  return tokens
}
