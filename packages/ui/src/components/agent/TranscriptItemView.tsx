import type { MessageAttachment } from '@workerdeck/protocol'
import { useEffect, useState } from 'react'
import type { ShellItem, TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { compactionText, formatCost, formatDuration, formatRelativeTime } from '../../lib/format.ts'
import { FileCard } from './FileCard.tsx'
import { Message, MessageContent } from './Message.tsx'
import { PromptTokenText } from './PromptTokenText.tsx'
import { Reasoning } from './Reasoning.tsx'
import { Response } from './Response.tsx'
import { ToolCallCard } from './ToolCallCard.tsx'
import { Row } from '../terminal/row.tsx'
import { TerminalItemView } from '../terminal/TerminalTranscript.tsx'
import { peerLabel } from '../terminal/items.tsx'
import { useShellActions } from './shell-actions.tsx'
import { AgentWriteAction, BookmarkAction, CopyAction, KillShellAction, OpenShellAction, WithActions } from '../terminal/affordances.tsx'
import {
  shellAgentWriteLabel,
  shellBodyLines,
  shellFailed,
  shellFooterText,
  shellGrantable,
  shellLabel,
  shellStatusText,
} from '../terminal/shell-row.ts'

function TurnResultRow({ item }: { item: Extract<TranscriptItem, { kind: 'turn_result' }> }) {
  return (
    <div data-slot="turn-result" className="py-1">
      <div className="flex items-center gap-2">
        <div className="h-px flex-1 bg-border" />
        <span className={cn('font-mono text-label', item.isError ? 'text-danger' : 'text-fg-4')}>
          {item.isError ? item.subtype : 'turn done'} · {formatDuration(item.durationMs)} · {formatCost(item.costUsd ?? item.totalCostUsd)}
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

// The item-view switch: one transcript item, drawn for the active variant.
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
        <WithActions actions={<BookmarkAction id={item.id} />}>
          <Message from="user">
            {item.origin ? <div className="wd-peer-origin text-xs text-muted-foreground">{peerLabel(item.origin)}</div> : null}
            {item.attachments?.length ? <SentAttachments attachments={item.attachments} attachmentUrl={attachmentUrl} /> : null}
            {item.text ? (
              <MessageContent>
                <PromptTokenText text={item.text} />
              </MessageContent>
            ) : null}
          </Message>
        </WithActions>
      )
    }
    case 'assistant_text': {
      return (
        <WithActions
          actions={
            <>
              <BookmarkAction id={item.id} />
              {item.streaming ? null : <CopyAction text={item.text} label="Copy message" />}
            </>
          }
        >
          <Message from="assistant">
            <MessageContent>
              <Response streaming={item.streaming}>{item.text}</Response>
            </MessageContent>
          </Message>
        </WithActions>
      )
    }
    case 'thinking': {
      return <Reasoning isStreaming={item.id === 'streaming-thinking'}>{item.text}</Reasoning>
    }
    case 'tool_call': {
      return <ToolCard item={item} hostImage={hostImage} />
    }
    case 'turn_result': {
      return <TurnResultRow item={item} />
    }
    case 'notice': {
      return <NoticeRow item={item} />
    }
    case 'compaction': {
      return <CompactionRow item={item} />
    }
    case 'file_delivered': {
      return <FileCard item={item} href={fileUrl?.(item.path)} />
    }
    case 'shell': {
      return <ShellCard item={item} />
    }
    default: {
      return null
    }
  }
}

function ToolCard({
  item,
  hostImage,
}: {
  item: Extract<TranscriptItem, { kind: 'tool_call' }>
  hostImage?: (path: string) => Promise<string | undefined>
}) {
  const command = (item.input as { command?: unknown } | null)?.command
  const copyable = typeof command === 'string' ? command : (item.result?.text ?? '')
  return (
    <WithActions
      actions={
        <>
          <BookmarkAction id={item.id} />
          {copyable ? <CopyAction text={copyable} label="Copy" /> : null}
        </>
      }
    >
      <ToolCallCard item={item} hostImage={hostImage} />
    </WithActions>
  )
}

function ShellCard({ item }: { item: ShellItem }) {
  const [open, setOpen] = useState(false)
  const actions = useShellActions()
  const running = item.shell.status === 'running'
  const failed = shellFailed(item)
  const lines = shellBodyLines(item, open)
  const footer = shellFooterText(item, open, lines.length)

  const shellId = item.shell.id
  const verify = actions.verify
  useEffect(() => {
    if (running) {
      void verify(shellId)
    }
  }, [running, shellId, verify])

  return (
    <WithActions
      actions={
        <>
          {actions.open ? <OpenShellAction onOpen={() => actions.open?.(shellId)} /> : null}
          {actions.agentWrite && shellGrantable(item.shell) ? (
            <AgentWriteAction
              granted={item.shell.agentWrite === true}
              label={shellAgentWriteLabel(item.shell)}
              onToggle={() => void actions.agentWrite?.(shellId, item.shell.agentWrite !== true)}
            />
          ) : null}
          {running ? <KillShellAction onKill={() => void actions.kill(shellId)} /> : null}
          <BookmarkAction id={item.id} />
          <CopyAction text={item.shell.command} label="Copy command" />
        </>
      }
    >
      <div data-slot="shell" className="overflow-hidden rounded-md border border-border bg-surface">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="font-mono text-label text-[var(--wd-shell-accent)]">$</span>
          <button
            type="button"
            aria-expanded={open}
            className="min-w-0 flex-1 truncate text-left font-mono text-label text-fg-1"
            onClick={() => {
              const next = !open
              setOpen(next)
              if (next && item.truncated && item.expanded === undefined && !item.missing) {
                void actions.loadOutput(shellId)
              }
            }}
          >
            {shellLabel(item)}
          </button>
          <span className={cn('shrink-0 text-label', failed ? 'text-danger' : 'text-fg-4')}>{shellStatusText(item)}</span>
        </div>
        {lines.length > 0 ? (
          <pre className="overflow-x-auto border-t border-border px-3 py-2 font-mono text-label whitespace-pre-wrap text-fg-2">
            {lines.join('\n')}
          </pre>
        ) : null}
        {footer ? <div className="px-3 pb-2 text-label text-fg-4">{footer}</div> : null}
      </div>
    </WithActions>
  )
}

function CompactionRow({ item }: { item: Extract<TranscriptItem, { kind: 'compaction' }> }) {
  return (
    <div data-slot="compaction" className="flex items-center gap-2 py-1">
      <div className="h-px flex-1 bg-border" />
      <span className={`font-mono text-label ${item.error === undefined ? 'text-fg-3' : 'text-danger'}`}>
        {item.pending ? '⋯' : '≡'} {compactionText(item)}
      </span>
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
