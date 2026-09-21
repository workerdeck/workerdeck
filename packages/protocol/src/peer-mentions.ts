// `#Name` in a composer names another session on the gateway. The client writes the token, the
// gateway resolves it, and the two must fold a title the same way or a picked name would not match
// itself. Everything here is pure, so the same rule runs in a browser, in a webview and on a server.

export const PEER_MENTION_SIGIL = '#'

// Distinct sessions expanded per message. Four is past any real sentence, and keeps the block a
// short prompt carries from outweighing the prompt.
export const PEER_MENTION_MAX = 4

export const PEER_MENTION_BODY_MAX = 64

// A scan bound, not a policy: a pasted file of hashes must not cost a resolution pass per line.
export const PEER_MENTION_SCAN_MAX = 32

export type PeerMentionToken = { start: number; end: number; body: string }

// Trailing punctuation belongs to the sentence, not to the name. Shared with `scanPromptTokens`,
// which scans the same text for `@file` and `/command`, so one boundary answers for all of them.
export const PROMPT_SENTENCE_TAIL: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'"])

const MENTION_BODY = /^[\p{L}\p{N}][\p{L}\p{N}\-_]*$/u

// What the composer writes for a session, and the only spelling the resolver is guaranteed to
// match. An untitled session falls back to the short id `sessionLabel` already draws.
export function peerMentionSlug(title: string | undefined, id: string): string {
  const slug = (title ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PEER_MENTION_BODY_MAX)
    .replace(/^-+|-+$/g, '')
  return slug || id.slice(0, 8)
}

// The comparison key. Both sides fold; neither compares raw, so `#astra` finds `Astra` and
// `#fix_login_bug` finds `Fix login bug`.
export function peerMentionKey(body: string): string {
  return body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function isPeerMentionBody(body: string): boolean {
  return body.length > 0 && body.length <= PEER_MENTION_BODY_MAX && MENTION_BODY.test(body)
}

// The boundary rule, mirroring `scanPromptTokens`: a sigil at the start of a word, a body to the
// next whitespace, sentence punctuation peeled off the end. `# heading` and `issue#42` are not
// mentions, and neither is `#-x`.
export function scanPeerMentions(text: string): PeerMentionToken[] {
  const tokens: PeerMentionToken[] = []
  const words = /\S+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null && tokens.length < PEER_MENTION_SCAN_MAX) {
    if (match[0][0] !== PEER_MENTION_SIGIL) {
      continue
    }
    let end = match.index + match[0].length
    while (end > match.index && PROMPT_SENTENCE_TAIL.has(text[end - 1]!)) {
      end--
    }
    const body = text.slice(match.index + 1, end)
    if (!isPeerMentionBody(body)) {
      continue
    }
    tokens.push({ start: match.index, end, body })
  }
  return tokens
}
