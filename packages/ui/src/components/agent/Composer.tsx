import { useMemo, type ReactNode } from 'react'
import type { SlashCommandInfo } from '@workerdeck/protocol'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { PromptArea } from '../prompt-area/prompt-area.tsx'
import { usePromptAreaState } from '../prompt-area/use-prompt-area-state.ts'
import { commandTrigger } from '../prompt-area/trigger-presets.ts'
import type { TriggerSuggestion } from '../prompt-area/types.ts'
import { cn } from '../../lib/utils.ts'

export interface ComposerProps {
  onSend: (text: string) => void
  onInterrupt: () => void
  busy: boolean
  /** Disable input entirely (session failed/closed). */
  disabled?: boolean
  placeholder?: string
  /** Slash commands offered as autocomplete; picked ones render as chips. */
  commands?: SlashCommandInfo[]
  /** Left side of the toolbar row (mode selects, attachments, …). */
  toolbar?: ReactNode
  className?: string
}

/** CLI names may carry display annotations (e.g. "foo (MCP)") the parser rejects. */
const cleanName = (name: string) => name.replace(/\s*\(MCP\)$/i, '')

/** Framed prompt input built on prompt-area's contentEditable: typing "/" — at the
 * start or after whitespace — opens a suggestion dropdown fed by `commands`, and a
 * picked command becomes an inline chip. Submit button flips to stop while a turn
 * is running (messages still queue while busy). */
export function Composer({
  onSend,
  onInterrupt,
  busy,
  disabled,
  placeholder = 'Message Claude…',
  commands,
  toolbar,
  className,
}: ComposerProps) {
  const { bind, plainText, isEmpty, clear, focus } = usePromptAreaState()

  const triggers = useMemo(() => {
    if (!commands || commands.length === 0) return undefined
    // The CLI list can contain the same skill name from several sources — first wins.
    const seen = new Set<string>()
    const unique = commands.flatMap((c) => {
      const name = cleanName(c.name)
      if (seen.has(name)) return []
      seen.add(name)
      return [{ ...c, name }]
    })
    return [
      commandTrigger({
        onSearch: (query: string): TriggerSuggestion[] => {
          const needle = query.toLowerCase()
          const scored = unique.flatMap((c) => {
            const haystacks = [c.name, ...(c.aliases ?? [])].map((s) => s.toLowerCase())
            const score = haystacks.some((h) => h.startsWith(needle))
              ? 2
              : haystacks.some((h) => h.includes(needle))
                ? 1
                : 0
            return score === 0 ? [] : [{ c, score }]
          })
          scored.sort((a, b) => b.score - a.score)
          return scored.map(({ c }) => ({
            value: c.name,
            label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
            description: c.description,
          }))
        },
        // Chip text renders as trigger + displayText — return the bare name so
        // the chip reads "/name" (label carries the argument hint for the menu).
        onSelect: (suggestion) => suggestion.value,
        chipClassName: 'font-mono',
      }),
    ]
  }, [commands])

  const submit = () => {
    const trimmed = plainText.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    clear()
    focus()
  }

  const canSend = !disabled && !isEmpty

  return (
    <div data-slot='composer' className={cn('px-3 pb-3', className)}>
      <div
        className={cn(
          'mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-bg shadow-(--shadow-xs)',
          'transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          disabled && 'opacity-60',
        )}>
        <PromptArea
          {...bind}
          triggers={triggers}
          onSubmit={submit}
          disabled={disabled}
          placeholder={disabled ? 'Session ended' : placeholder}
          minHeight={28}
          maxHeight={192}
          aria-label='Message Claude'
          className='px-3 pt-2.5 pb-1 text-body-sm text-text'
        />
        <div className='flex items-center justify-between gap-2 px-2 pb-2'>
          <div className='flex min-w-0 items-center gap-1'>{toolbar}</div>
          {busy ? (
            <Button
              variant='outline'
              size='icon-sm'
              aria-label='Interrupt'
              className='rounded-full'
              onClick={onInterrupt}>
              <Square className='size-3' />
            </Button>
          ) : (
            <Button
              size='icon-sm'
              aria-label='Send'
              className='rounded-full'
              disabled={!canSend}
              onClick={submit}>
              <ArrowUp className='size-4' />
            </Button>
          )}
        </div>
      </div>
      <div className='mx-auto mt-1 w-full max-w-3xl text-center text-label text-fg-4'>
        Enter to send · Shift+Enter for a new line
      </div>
    </div>
  )
}
