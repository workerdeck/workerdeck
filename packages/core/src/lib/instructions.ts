export type InstructionsContext = {
  sessionId: string
  cwd?: string
  profile?: string
}

export type SessionInstructions = string | ((context: InstructionsContext) => string)

export function resolveInstructions(instructions: SessionInstructions | undefined, context: InstructionsContext): string | undefined {
  if (instructions === undefined) {
    return undefined
  }
  const text = (typeof instructions === 'function' ? instructions(context) : instructions).trim()
  return text === '' ? undefined : text
}

export function composeInstructions(...parts: Array<SessionInstructions | undefined>): SessionInstructions | undefined {
  const present = parts.filter((part) => part !== undefined && part !== '')
  if (present.length <= 1) {
    return present[0]
  }
  if (present.every((part) => typeof part === 'string')) {
    return present.join('\n\n')
  }
  return (context) =>
    present
      .map((part) => resolveInstructions(part, context))
      .filter((text) => text !== undefined)
      .join('\n\n')
}
