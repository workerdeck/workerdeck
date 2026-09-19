export type PromptToken = {
  kind: 'file' | 'command' | 'skill'
  start: number
  end: number
  text: string
}

// `$name` is codex's skill mention; only a name the session listed is a token, so a dollar amount is not.
export type PromptTokenOptions = {
  skills?: readonly string[]
}

// No `/`, so a pasted absolute path is not a command; `:` is in for namespaced skills (`dev:wrapup`).
const COMMAND_BODY = /^[A-Za-z0-9\-_.:]+$/

const SENTENCE_TAIL = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'"])

export function scanPromptTokens(text: string, options?: PromptTokenOptions): PromptToken[] {
  const tokens: PromptToken[] = []
  const skills = options?.skills?.length ? new Set(options.skills) : undefined
  const words = /\S+/g
  let match: RegExpExecArray | null
  while ((match = words.exec(text)) !== null) {
    const word = match[0]
    const kind = word[0] === '@' ? 'file' : word[0] === '/' ? 'command' : word[0] === '$' && skills ? 'skill' : undefined
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
    tokens.push({ kind, start: match.index, end, text: text.slice(match.index, end) })
  }
  return tokens
}
