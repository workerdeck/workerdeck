import { Fragment, type ReactNode } from 'react'
import { findUrls } from '../../lib/terminal-links.ts'

export function UrlText({ text }: { text: string }): ReactNode {
  const urls = findUrls(text)
  if (urls.length === 0) {
    return text
  }
  const parts: ReactNode[] = []
  let at = 0
  for (const { url, start, end } of urls) {
    parts.push(text.slice(at, start))
    parts.push(
      <a key={start} className="term-link" data-tone="blue" href={url} target="_blank" rel="noreferrer">
        {url}
      </a>,
    )
    at = end
  }
  parts.push(text.slice(at))
  return <Fragment>{parts}</Fragment>
}
