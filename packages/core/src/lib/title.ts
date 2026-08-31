import type { CreateSessionRequest } from '@workerdeck/protocol'

type TitleSource = Pick<CreateSessionRequest, 'meta' | 'prompt'>

/** The host's rename (`meta.title`), or undefined when unset. The one statement
 * of "a person's rename outranks everything": `sessionTitle` prefers it, and
 * the Claude engine-title poll refuses to even read while it is set. */
export const hostTitle = (meta: CreateSessionRequest['meta']): string | undefined => {
  const title = meta?.title
  return typeof title === 'string' && title.length > 0 ? title : undefined
}

/** Most-deliberate first: the host's rename, the engine's own title (only the
 * Claude engine has one to pass), then the first prompt truncated. */
export const sessionTitle = (config: TitleSource, engineTitle?: string): string | undefined => {
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

/** Host-facing rename, the body of every runner's `setTitle`: a config copy
 * whose `meta.title` is `title` — cleared when undefined, restoring the derived
 * title. The engine is never told. */
export const withTitle = <C extends TitleSource>(config: C, title: string | undefined): C => {
  const meta = { ...config.meta }
  if (title) {
    meta.title = title
  } else {
    delete meta.title
  }
  return { ...config, meta }
}
