import { Fragment } from 'react'
import { scanPromptTokens } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'

/**
 * A sent message, with its `@file` and `/command` tokens styled the way the CLI
 * writes them: monospace and tinted, no background — the bubble already has one,
 * and a second fill inside it reads as a button.
 *
 * Literal text, never markdown: what was typed is what was sent. The one pass
 * over it is this, so a message reads the same after sending as it did in the
 * composer. Two tokens, two meanings — a file is a reference, a command is an
 * action — so they are told apart by hue rather than by shape alone.
 */
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
