import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { scanPromptTokens } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'

const SkillNamesContext = createContext<readonly string[] | undefined>(undefined)

// The skill names a `$name` in a sent message may resolve to; unset, nothing is a skill token.
export function SkillNamesProvider({ names, children }: { names: readonly string[] | undefined; children: ReactNode }) {
  return <SkillNamesContext.Provider value={names}>{children}</SkillNamesContext.Provider>
}

export function PromptTokenText({ text, className }: { text: string; className?: string }) {
  const skills = useContext(SkillNamesContext)
  const tokens = scanPromptTokens(text, { skills })
  if (tokens.length === 0) {
    return <span className={className}>{text}</span>
  }
  const parts: ReactNode[] = []
  let cursor = 0
  for (const [index, token] of tokens.entries()) {
    if (token.start > cursor) {
      parts.push(text.slice(cursor, token.start))
    }
    parts.push(
      <span key={`${token.start}-${index}`} className={cn('font-mono', token.kind === 'file' ? 'text-accent' : 'text-info')}>
        {token.text}
      </span>,
    )
    cursor = token.end
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return (
    <span className={className}>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </span>
  )
}
