export interface TextUrl {
  url: string
  start: number
  end: number
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi
const TRAILING = /[.,;:!?]+$/
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

export function findUrls(text: string): TextUrl[] {
  const found: TextUrl[] = []
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0])
    if (/^https?:\/\/[^/?#]/i.test(url)) {
      found.push({ url, start: match.index, end: match.index + url.length })
    }
  }
  return found
}

function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const before = url
    url = url.replace(TRAILING, '')
    const last = url.at(-1)
    const open = last ? PAIRS[last] : undefined
    if (open && count(url, last!) > count(url, open)) {
      url = url.slice(0, -1)
    }
    if (url === before) {
      return url
    }
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1
}

export function isOpenGesture(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey
}
