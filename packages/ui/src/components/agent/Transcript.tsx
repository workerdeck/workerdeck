import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatDuration } from '../../lib/format.ts'
import { Conversation, ConversationContent, ConversationScrollButton } from './Conversation.tsx'
import { FileCard } from './FileCard.tsx'
import { Loader } from './Loader.tsx'
import { Message, MessageContent } from './Message.tsx'
import { Reasoning } from './Reasoning.tsx'
import { Response } from './Response.tsx'
import { ToolCallCard } from './ToolCallCard.tsx'

function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
  return (
    <div data-slot='turn-result' className='flex items-center gap-2 py-1'>
      <div className='h-px flex-1 bg-border' />
      <span className={cn('font-mono text-label', item.isError ? 'text-danger' : 'text-fg-4')}>
        {item.isError ? item.subtype : 'turn done'} · {formatDuration(item.durationMs)} ·{' '}
        {formatCost(item.totalCostUsd)}
      </span>
      <div className='h-px flex-1 bg-border' />
    </div>
  )
}

function NoticeRow({ item }: { item: Extract<TranscriptItem, { kind: 'notice' }> }) {
  return (
    <div
      data-slot='notice'
      className={cn(
        'rounded-md border px-3 py-2 text-body-sm',
        item.level === 'error'
          ? 'border-transparent bg-danger-bg text-danger'
          : 'border-border bg-surface text-fg-3',
      )}>
      {item.text}
    </div>
  )
}

function TranscriptItemView({
  item,
  fileUrl,
}: {
  item: TranscriptItem
  fileUrl?: (path: string) => string
}) {
  switch (item.kind) {
    case 'user':
      return (
        <Message from='user'>
          <MessageContent>{item.text}</MessageContent>
        </Message>
      )
    case 'assistant_text':
      return (
        <Message from='assistant'>
          <MessageContent>
            <Response streaming={item.streaming}>{item.text}</Response>
          </MessageContent>
        </Message>
      )
    case 'thinking':
      return <Reasoning isStreaming={item.id === 'streaming-thinking'}>{item.text}</Reasoning>
    case 'tool_call':
      return <ToolCallCard item={item} />
    case 'turn_result':
      return <TurnResultRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
    case 'file_delivered':
      return <FileCard item={item} href={fileUrl?.(item.path)} />
    default:
      return null
  }
}

/** Should the "waiting for output" loader show? Only while running with no in-flight
 * streamed content at the tail of the transcript. */
function showLoader(state: TranscriptState): boolean {
  if (state.status !== 'running' && state.status !== 'starting') return false
  const last = state.items.at(-1)
  if (!last) return true
  if (last.kind === 'assistant_text' && last.streaming) return false
  if (last.kind === 'thinking' && last.id === 'streaming-thinking') return false
  return last.kind !== 'turn_result' || state.status === 'running'
}

export interface TranscriptProps {
  state: TranscriptState
  /** Builds the download URL for a delivered file (see FileCard). Typically
   * `(path) => client.sessionFileUrl(sessionId, path)`. */
  fileUrl?: (path: string) => string
  className?: string
}

export function Transcript({ state, fileUrl, className }: TranscriptProps) {
  return (
    <Conversation className={className}>
      <ConversationContent>
        {state.items.length === 0 && state.status !== 'starting' ? (
          <div className='py-12 text-center text-body-sm text-fg-4'>No messages yet.</div>
        ) : (
          state.items.map((item) => (
            <TranscriptItemView key={`${item.kind}:${item.id}`} item={item} fileUrl={fileUrl} />
          ))
        )}
        {showLoader(state) ? (
          <Loader label={state.status === 'starting' ? 'Starting session…' : undefined} />
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  )
}
