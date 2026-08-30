import { Fragment } from 'react'
import { scanPromptTokens } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'

/** A sent message with its `@file` and `/command` tokens tinted. Literal text,
 * never markdown: what was typed is what was sent. */
export function PromptTokenText({ text, className }: { text: string; className?: string }) {
  const tokens = scanPromptTokens(text)
  if (tokens.length === 0) {
    return <span className={className}>{text}</span>
  }
  const parts: React.ReactNode[] = []
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
