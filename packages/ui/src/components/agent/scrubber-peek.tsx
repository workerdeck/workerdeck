import type { ReactNode } from 'react'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { toolInputPreview } from '../../lib/format.ts'
import { permissionPromptModel } from '../../lib/permission-prompt.ts'
import { doneLine, excerpt, KIND_NAME, type Cluster, type Mark } from './scrubber-marks.ts'

export type PeekSkin = {
  excerptClass: string
  muted: string
  danger: string
  glyph: string
  text?: string
  strong?: string
  detail?: string
  answerGlyph?: string
}

export const CARD_PEEK: PeekSkin = { excerptClass: 'wd-scrub-ex', muted: 'muted', danger: 'danger', glyph: 'muted', detail: 'muted' }

export const TERMINAL_PEEK: PeekSkin = {
  excerptClass: 'term-scrub-ex',
  muted: 'faint',
  danger: 'red',
  glyph: 'dim',
  text: 'fg',
  strong: 'bright',
  detail: 'fg',
  answerGlyph: '● ',
}

export interface PeekInput {
  cluster: Cluster
  first: Mark | undefined
  items: readonly TranscriptItem[]
  pendingApprovals: readonly PermissionRequest[]
  recapLabel?: string
}

export function peekContent({ cluster, first, items, pendingApprovals, recapLabel }: PeekInput, skin: PeekSkin): ReactNode {
  const more = cluster.marks.length > 1 ? ` · ${cluster.marks.length} marks` : ''
  const kind = first?.kind ?? cluster.kind
  return (
    <>
      <div data-tone={skin.muted}>
        {KIND_NAME[kind]}
        {more}
      </div>
      {cluster.kind === 'approval'
        ? approvalBody(pendingApprovals[0], skin)
        : kind === 'recap'
          ? recapBody(recapLabel, skin)
          : markBody(first, items, skin)}
    </>
  )
}

function approvalBody(request: PermissionRequest | undefined, skin: PeekSkin): ReactNode {
  if (!request) {
    return null
  }
  return (
    <>
      <div data-tone={skin.strong}>{permissionPromptModel(request).heading}</div>
      <div className={skin.excerptClass} data-tone={skin.detail}>
        {`${request.displayName ?? request.toolName}(${toolInputPreview(request.input)})`}
      </div>
    </>
  )
}

function recapBody(label: string | undefined, skin: PeekSkin): ReactNode {
  return label === undefined ? null : <div data-tone={skin.muted}>※ {label}</div>
}

function markBody(first: Mark | undefined, items: readonly TranscriptItem[], skin: PeekSkin): ReactNode {
  if (!first) {
    return null
  }
  const item = items[first.itemIndex]
  if (first.kind === 'turn' || first.kind === 'turnFailed') {
    const turn = first.turnIndex === undefined ? undefined : items[first.turnIndex]
    return (
      <>
        {item?.kind === 'assistant_text' || (item?.kind === 'thinking' && item.addressed) ? (
          <div className={skin.excerptClass} data-tone={skin.text}>
            {skin.answerGlyph ? <span data-tone={skin.glyph}>{skin.answerGlyph}</span> : null}
            {item.text}
          </div>
        ) : null}
        {turn?.kind === 'turn_result' ? (
          <>
            <div data-tone={turn.isError ? skin.danger : skin.muted}>{doneLine(turn)}</div>
            {turn.errors?.map((message, index) => (
              <div key={index} data-tone={skin.danger}>
                {message}
              </div>
            ))}
          </>
        ) : null}
      </>
    )
  }
  if (!item) {
    return null
  }
  const failure =
    first.kind === 'toolFailed' && item.kind === 'tool_call' ? item.result?.text.split('\n').find((line) => line.trim() !== '') : undefined
  return (
    <>
      <div className={skin.excerptClass} data-tone={first.kind === 'error' || first.kind === 'toolFailed' ? skin.danger : skin.text}>
        {first.kind === 'user' ? <span data-tone={skin.glyph}>{'❯ '}</span> : null}
        {excerpt(item)}
      </div>
      {failure ? (
        <div className={skin.excerptClass} data-tone={skin.danger}>
          {failure}
        </div>
      ) : null}
    </>
  )
}
