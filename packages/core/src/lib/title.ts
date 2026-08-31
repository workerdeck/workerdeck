import type { CreateSessionRequest } from '@workerdeck/protocol'

type TitleSource = Pick<CreateSessionRequest, 'meta' | 'prompt'>

export function hostTitle(meta: CreateSessionRequest['meta']): string | undefined {
  const title = meta?.title
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

export function sessionTitle(config: TitleSource, engineTitle?: string): string | undefined {
  const host = hostTitle(config.meta)
  if (host) {
    return host
  }
  if (engineTitle) {
    return engineTitle
  }
  const prompt = config.prompt
  if (!prompt) {
    return undefined
  }
  return prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt
}

export function withTitle<C extends TitleSource>(config: C, title: string | undefined): C {
  const meta = { ...config.meta }
  if (title) {
    meta.title = title
  } else {
    delete meta.title
  }
  return { ...config, meta }
}
