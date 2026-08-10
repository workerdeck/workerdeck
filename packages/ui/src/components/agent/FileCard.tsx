import type { TranscriptItem } from '@workerdeck/react'
import { Download, FileText } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { formatBytes } from '../../lib/format.ts'
import { LineGlyph, useLines } from './transcript-variant.tsx'

export type FileDeliveredItem = Extract<TranscriptItem, { kind: 'file_delivered' }>

export interface FileCardProps {
  item: FileDeliveredItem
  /** Download URL for the delivered path (the server's session file route).
   * Without it the card renders informational only. */
  href?: string
  className?: string
}

/** A file the agent handed over (`file_delivered`): name, size, download link.
 * The file lives in the session's in-memory VFS — the link works while the
 * session lives. */
export function FileCard({ item, href, className }: FileCardProps) {
  const lines = useLines()
  const name = item.path.split('/').pop() || item.path
  if (lines) {
    // One row: what arrived, how big, and the link — no box around it.
    return (
      <div data-slot='file-delivered' className={cn('flex w-full items-baseline gap-2', className)}>
        <LineGlyph className='text-fg-4'>◇</LineGlyph>
        <span className='min-w-0 flex-1 truncate text-body-sm leading-5'>
          <span className='font-medium text-fg-1'>{name}</span>
          <span className='text-fg-4'>
            {' · '}
            {formatBytes(item.bytes)}
            {item.description ? ` · ${item.description}` : ''}
          </span>
        </span>
        {href ? (
          <a
            href={href}
            download={name}
            className='shrink-0 text-label text-fg-3 underline-offset-2 hover:text-fg-1 hover:underline'>
            download
          </a>
        ) : null}
      </div>
    )
  }
  return (
    <div
      data-slot='file-delivered'
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5',
        className,
      )}>
      <FileText className='size-4 shrink-0 text-fg-3' />
      <div className='min-w-0 flex-1'>
        <div className='truncate font-mono text-body-sm font-medium text-fg-1'>{name}</div>
        <div className='truncate text-label text-fg-4'>
          {formatBytes(item.bytes)}
          {item.description ? ` · ${item.description}` : ''}
        </div>
      </div>
      {href ? (
        <a
          href={href}
          download={name}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5',
            'text-body-sm text-fg-2 transition-colors hover:bg-surface-hover',
          )}>
          <Download className='size-3.5' />
          Download
        </a>
      ) : null}
    </div>
  )
}
