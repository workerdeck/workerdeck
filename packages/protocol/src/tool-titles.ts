export const TOOL_TITLE_MAX_CHARS = 64

// Capability tools the sandbox grants and the synthetic names the codex adapter invents: wire
// names with no public vocabulary behind them. An engine's own tool names (`Bash`, `Read`,
// `Task`) are deliberately absent — those are the CLI's published names and users read them.
export const BUILTIN_TOOL_TITLES: Record<string, string> = {
  fs_read: 'Reading a file',
  fs_write: 'Writing a file',
  fs_list: 'Listing files',
  eval_script: 'Running a script',
  web_fetch: 'Fetching a web page',
  web_search: 'Searching the web',
  deliver_file: 'Delivering a file',
  download: 'Downloading a file',
  CodexCommand: 'Running a command',
  CodexFileChange: 'Editing a file',
  CodexWebSearch: 'Searching the web',
  CodexImageGeneration: 'Generating an image',
  CodexImageView: 'Viewing an image',
}

export function toolTitle(name: string, titles?: Record<string, string>): string | undefined {
  return sanitizeToolTitle(titles?.[name] ?? BUILTIN_TOOL_TITLES[name], name)
}

// Titles reach here from remote MCP servers, so they are untrusted display text: one line,
// clamped, and never a restatement of the wire name the caller already has.
export function sanitizeToolTitle(title: string | undefined, name?: string): string | undefined {
  if (typeof title !== 'string') {
    return undefined
  }
  const flat = title
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat === '' || flat === name) {
    return undefined
  }
  // By code point, not code unit: a clamp that splits a surrogate pair renders a replacement
  // character, and the clients that mirror this rule do not count in UTF-16.
  const points = [...flat]
  return points.length > TOOL_TITLE_MAX_CHARS ? points.slice(0, TOOL_TITLE_MAX_CHARS - 1).join('') + '…' : flat
}
