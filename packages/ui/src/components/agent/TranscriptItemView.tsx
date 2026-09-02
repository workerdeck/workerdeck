import type { MessageAttachment } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { COMPACTION_TEXT, formatCost, formatDuration, formatRelativeTime } from '../../lib/format.ts'
import { FileCard } from './FileCard.tsx'
import { Message, MessageContent } from './Message.tsx'
import { PromptTokenText } from './PromptTokenText.tsx'
import { Reasoning } from './Reasoning.tsx'
import { Response } from './Response.tsx'
import { ToolCallCard } from './ToolCallCard.tsx'
import { Row } from '../terminal/row.tsx'
import { TerminalItemView } from '../terminal/TerminalTranscript.tsx'

function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
  return (
    <div data-slot="turn-result" className="py-1">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <span className={cn('font-mono text-label', item.isError ? 'text-danger' : 'text-fg-4')}>
          {item.isError ? item.subtype : 'turn done'} · {formatDuration(item.durationMs)} · {formatCost(item.totalCostUsd)}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>
      {item.errors?.length ? (
        <ul className="mt-1 flex flex-col gap-0.5 text-center">
          {item.errors.map((message, index) => (
            <li key={index} className="text-label break-words text-danger">
              {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function NoticeRow({ item }: { item: Extract<TranscriptItem, { kind: 'notice' }> }) {
  return (
    <div
      data-slot="notice"
      className={cn(
        'rounded-md border px-3 py-2 text-body-sm',
        item.level === 'error' ? 'border-transparent bg-danger-bg text-danger' : 'border-border bg-surface text-fg-3',
      )}
    >
      {item.text}
    </div>
  )
}

/** The item-view switch: one transcript item, drawn for the active variant. */
export function TranscriptItemView({
  item,
  fileUrl,
  attachmentUrl,
  hostImage,
  terminal,
}: {
  item: TranscriptItem
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
  hostImage?: (path: string) => Promise<string | undefined>
  terminal?: boolean
}) {
  if (terminal) {
    return <TerminalItemView item={item} fileUrl={fileUrl} />
  }
  switch (item.kind) {
    case 'user': {
      return (
        <Message from="user">
          {item.attachments?.length ? <SentAttachments attachments={item.attachments} attachmentUrl={attachmentUrl} /> : null}
          {item.text ? (
            <MessageContent>
              <PromptTokenText text={item.text} />
            </MessageContent>
          ) : null}
        </Message>
      )
    }
    case 'assistant_text': {
      return (
        <Message from="assistant">
          <MessageContent>
            <Response streaming={item.streaming}>{item.text}</Response>
          </MessageContent>
        </Message>
      )
    }
    case 'thinking': {
      return <Reasoning isStreaming={item.id === 'streaming-thinking'}>{item.text}</Reasoning>
    }
    case 'tool_call': {
      return <ToolCallCard item={item} hostImage={hostImage} />
    }
    case 'turn_result': {
      return <TurnResultRow item={item} />
    }
    case 'notice': {
      return <NoticeRow item={item} />
    }
    case 'compaction': {
      return <CompactionRow />
    }
    case 'file_delivered': {
      return <FileCard item={item} href={fileUrl?.(item.path)} />
    }
    default: {
      return null
    }
  }
}

function CompactionRow() {
  return (
    <div data-slot="compaction" className="flex items-center gap-2 py-1">
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-label text-fg-3">≡ {COMPACTION_TEXT}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

export function RecapRow({ line, since, terminal }: { line: string; since?: number; terminal?: boolean }) {
  const away = since === undefined ? undefined : formatRelativeTime(since)
  const text = away ? `${line} · last here ${away}` : line

  if (terminal) {
    return (
      <div data-slot="recap">
        <Row glyph="※" glyphTone="faint" tone="faint">
          recap: {text}
        </Row>
      </div>
    )
  }

  return (
    <div data-slot="recap" className="flex items-center gap-2 py-1">
      <div className="h-px flex-1 bg-border" />
      <span className="font-mono text-label text-fg-3">※ recap: {text}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}

function SentAttachments({
  attachments,
  attachmentUrl,
}: {
  attachments: MessageAttachment[]
  attachmentUrl?: (attachmentId: string) => string
}) {
  return (
    <div className="mb-1 flex flex-wrap justify-start gap-1.5">
      {attachments.map((attachment) => {
        const href = attachmentUrl?.(attachment.id)
        return attachment.mediaType.startsWith('image/') && href ? (
          <img key={attachment.id} src={href} alt={attachment.name} className="size-20 rounded-md border border-border object-cover" />
        ) : (
          <span key={attachment.id} className="rounded-full border border-border bg-surface px-2.5 py-1 text-body-xs text-fg-3">
            {attachment.name}
          </span>
        )
      })}
    </div>
  )
}
