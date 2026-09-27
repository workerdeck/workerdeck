import { Fragment, useMemo, useState } from 'react'
import type { TranscriptItem } from '@workerdeck/react'
import { cn } from '../../lib/utils.ts'
import { ActionPlacementProvider, OpenSubagentAction, WithActions } from './affordances.tsx'
import {
  AssistantRow,
  CompactionRow,
  FileRow,
  NoticeRow,
  PeerSendRow,
  RunRow,
  ShellRow,
  ThinkingRow,
  ToolRow,
  TurnResultRow,
  UserRow,
} from './items.tsx'
import { blockNeedsBlank, taskChildItems, type TaskBlock } from './blocks.ts'
import { usePulse } from '../agent/pulse.tsx'
import { Pressable, useRevealOnOpen } from './press.tsx'
import { isPeerSend, taskBrief, taskBusy, taskFailed, taskSummary } from './tool-run.ts'
import { BRIEF_LINES } from './height.ts'
import { Blank, Row } from './row.tsx'

export function TerminalItemView({
  item,
  fileUrl,
  attachmentUrl,
}: {
  item: TranscriptItem
  fileUrl?: (path: string) => string
  attachmentUrl?: (attachmentId: string) => string
}) {
  switch (item.kind) {
    case 'user': {
      return <UserRow item={item} attachmentUrl={attachmentUrl} />
    }
    case 'assistant_text': {
      return <AssistantRow item={item} />
    }
    case 'thinking': {
      return <ThinkingRow item={item} />
    }
    case 'tool_call': {
      return isPeerSend(item) ? <PeerSendRow item={item} /> : <ToolRow item={item} />
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
      return <FileRow item={item} href={fileUrl?.(item.path)} />
    }
    case 'shell': {
      return <ShellRow item={item} />
    }
    default: {
      return null
    }
  }
}

export function BriefRow({ text, terminal }: { text: string; terminal?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!terminal) {
    return (
      <div data-slot="brief" className="px-4 py-2 text-body-sm whitespace-pre-wrap text-fg-2">
        {text}
      </div>
    )
  }
  return (
    <div data-slot="brief">
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        <Row glyph=">" glyphTone="blue" tone="dim">
          <span
            className={cn('whitespace-pre-wrap', !open && 'term-brief-clip')}
            style={open ? undefined : { WebkitLineClamp: BRIEF_LINES }}
          >
            {text}
          </span>
        </Row>
      </Pressable>
    </div>
  )
}

export function TaskRow({
  block,
  fileUrl,
  onOpenSubagent,
}: {
  block: TaskBlock
  fileUrl?: (path: string) => string
  onOpenSubagent?: (toolUseId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const reveal = useRevealOnOpen(open)
  const children = useMemo(() => taskChildItems(block), [block])
  const brief = children.some((item) => item.kind === 'user') ? undefined : taskBrief(block.task)
  const busy = taskBusy(block.task, children)
  const failed = taskFailed(block.task)
  const pulse = usePulse(busy)

  const row = (
    <div ref={reveal} className={open ? 'term-open' : undefined}>
      <Pressable onPress={() => setOpen((v) => !v)} expanded={open}>
        <Row glyph={busy ? pulse : '●'} glyphTone={failed ? 'red' : busy ? 'mark' : 'dim'} tone={failed ? 'red' : 'green'}>
          {busy ? <span className="term-shimmer">{taskSummary(block.task, children)}</span> : taskSummary(block.task, children)}
        </Row>
      </Pressable>
      {open ? (
        <div className="term-nested">
          {brief ? <BriefRow text={brief} terminal /> : null}
          {block.children.map((leaf, index) => {
            const next = block.children[index + 1]
            const view = 'run' in leaf ? <RunRow items={leaf.run} /> : <TerminalItemView item={leaf.item} fileUrl={fileUrl} />
            return (
              <Fragment key={leaf.key}>
                {index > 0 && blockNeedsBlank(block.children[index - 1]!, leaf) ? <Blank /> : null}
                {next && !blockNeedsBlank(leaf, next) ? <ActionPlacementProvider value="inline">{view}</ActionPlacementProvider> : view}
              </Fragment>
            )
          })}
        </div>
      ) : null}
    </div>
  )
  return onOpenSubagent === undefined ? (
    row
  ) : (
    <WithActions actions={<OpenSubagentAction onOpen={() => onOpenSubagent(block.task.id)} />}>{row}</WithActions>
  )
}
