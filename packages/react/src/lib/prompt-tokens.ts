export type PromptToken = {
  kind: 'file' | 'command'
  start: number
  end: number
  text: string
}

// No `/`, so a pasted absolute path is not a command; `:` is in for namespaced skills (`dev:wrapup`).
const COMMAND_BODY = /^[A-Za-z0-9\-_.:]+$/

const SENTENCE_TAIL = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '"', "'"])

export const scanPromptTokens = (text: string): PromptToken[] => {
  const tokens: PromptToken[] = []
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
