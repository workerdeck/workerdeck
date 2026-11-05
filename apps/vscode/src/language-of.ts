export type LanguageIndex = { names: ReadonlyMap<string, string>; extensions: ReadonlyMap<string, string> }

// Longest extension wins, the way the language service resolves `.d.ts` before `.ts`.
export function languageOf(index: LanguageIndex, name: string): string | undefined {
  const lower = name.toLowerCase()
  const byName = index.names.get(lower)
  if (byName) {
    return byName
  }
  const segments = lower.split('.')
  for (let i = 1; i < segments.length; i++) {
    const match = index.extensions.get(segments.slice(i).join('.'))
    if (match) {
      return match
    }
  }
  return undefined
}
