import { AtSign, MessageSquareText, SlashSquare, Sparkles, Terminal } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export interface SessionEmptyStateProps {
  cwd?: string
  /** Whether `/command` completion is live yet — the CLI reports its commands a
   * beat after the session starts. */
  hasCommands?: boolean
  /** Whether the engine has reported skills. Its own flag, not a variant of
   * `hasCommands`: a command is submitted, a skill is typed for you to edit,
   * and an engine can have one without the other. */
  hasSkills?: boolean
  /** Whether this gateway serves `@file` search for the session's directory. */
  canBrowseFiles?: boolean
  className?: string
}

/** What a session shows before it has said anything. Every hint is conditional
 * on the affordance actually existing. */
export function SessionEmptyState({ cwd, hasCommands, hasSkills, canBrowseFiles, className }: SessionEmptyStateProps) {
  const hints = [
    { icon: MessageSquareText, text: 'Tell the agent what to do.' },
    // `$` is codex's own sigil for skills; `/` stays the CLI's commands.
    ...(hasCommands ? [{ icon: SlashSquare, text: 'Type / for the CLI’s slash commands.' }] : []),
    ...(hasSkills ? [{ icon: Sparkles, text: 'Type $ to draft a message for one of the agent’s skills.' }] : []),
    ...(canBrowseFiles ? [{ icon: AtSign, text: 'Type @ to search this project’s files.' }] : []),
  ]
  return (
    <div className={cn('flex flex-col items-center gap-4 py-10', className)}>
      <div className="flex size-12 items-center justify-center rounded-xl bg-surface text-fg-3">
        <Terminal className="size-5" />
      </div>
      {cwd ? <p className="max-w-full truncate font-mono text-label text-fg-4">{cwd}</p> : null}
      <ul className="w-full max-w-sm divide-y divide-border overflow-hidden rounded-lg bg-surface">
        {hints.map((hint) => (
          <li key={hint.text} className="flex items-center gap-3 px-3.5 py-2.5">
            <hint.icon className="size-4 shrink-0 text-fg-4" />
            <span className="text-body-sm text-fg-3">{hint.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
