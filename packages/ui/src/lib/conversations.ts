import type { ArchivedView, ConversationRow } from '@workerdeck/protocol'

export type ConversationRowText = {
  date: string
  title: string
  duration?: string
  current: boolean
}

export type ArchivedBannerText = {
  headline: string
  note?: string
}

export function conversationDate(at: number | undefined, locale?: string): string {
  if (at === undefined) {
    return 'Date unknown'
  }
  return new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function conversationSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) {
    return 'under a minute'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  }
  return `${Math.round(hours / 24)}d`
}

// The current conversation has no end yet, so its duration runs to `now`.
export function conversationRowText(row: ConversationRow, now = Date.now(), locale?: string): ConversationRowText {
  const end = row.endedAt ?? (row.current ? now : undefined)
  const duration =
    row.startedAt !== undefined && end !== undefined && end >= row.startedAt ? conversationSpan(end - row.startedAt) : undefined
  return {
    date: conversationDate(row.startedAt ?? row.endedAt, locale),
    title: row.title?.trim() || (row.transcript === 'unavailable' ? 'Transcript unavailable' : 'Untitled conversation'),
    ...(duration === undefined ? {} : { duration }),
    current: row.current,
  }
}

export function archivedBannerText(view: ArchivedView, locale?: string): ArchivedBannerText {
  const headline = `Past conversation · ${conversationDate(view.at, locale)}`
  const notes = [view.kind === 'deleted' ? 'Agent deleted' : undefined, view.unavailable ? 'Transcript unavailable' : undefined].filter(
    (note): note is string => note !== undefined,
  )
  return notes.length === 0 ? { headline } : { headline, note: notes.join(' · ') }
}
