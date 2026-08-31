import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { cn } from '../../lib/utils.ts'
import { Spinner } from '../ui/Spinner.tsx'

export interface CodeEditorProps {
  /** Absolute path — decides the language and identifies the model. */
  path: string
  /** Text to show. Applied to the model when it differs from what is on screen,
   * so an external reload lands without fighting the user's cursor. */
  value: string
  onChange?: (value: string) => void
  /** Ctrl/Cmd+S. Wired inside Monaco because the editor swallows keydown. */
  onSave?: () => void
  readOnly?: boolean
  className?: string
}

/**
 * Monaco behind a small React surface, **loaded on demand** (the `import()` is inside an effect,
 * so it is a separate chunk). **No `MonacoEnvironment` is configured here, and none is needed** —
 * the editor is configured never to ask for a worker (`wordBasedSuggestions` and
 * `quickSuggestions` off, no diff editor); a host that wants the language services sets it
 * itself before the first file is opened. One model per path, kept across tab switches, so undo
 * history and view state survive clicking away and back. Why: docs/PACKAGES.md §`packages/ui`.
 */
export function CodeEditor({ path, value, onChange, onSave, readOnly, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monaco = useRef<typeof Monaco | null>(null)
  const [ready, setReady] = useState(false)
  const theme = useDocumentTheme()

  // Callbacks through refs: they change identity every render, and
  // re-registering listeners on each one would drop the cursor mid-keystroke.
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  useEffect(() => {
    let disposed = false
    void loadMonaco().then((api) => {
      if (disposed || !host.current) {
        return
      }
      monaco.current = api
      const instance = api.editor.create(host.current, {
        value,
        language: languageOf(path),
        readOnly,
        automaticLayout: true,
        theme: monacoTheme(document.documentElement.getAttribute('data-theme')),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        lineHeight: 20,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        renderLineHighlight: 'line',
        smoothScrolling: true,
        padding: { top: 8, bottom: 8 },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        // Without a worker there is no suggestion provider, so asking would
        // surface an empty popup on every identifier.
        wordBasedSuggestions: 'off',
        quickSuggestions: false,
      })
      editor.current = instance
      instance.onDidChangeModelContent(() => {
        handlers.current.onChange?.(instance.getValue())
      })
      instance.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => {
        handlers.current.onSave?.()
      })
      setReady(true)
    })
    return () => {
      disposed = true
      // Dispose the editor but NOT its model — the model is keyed by path and
      // outlives this mount so that reopening a tab restores its undo stack.
      editor.current?.dispose()
      editor.current = null
      setReady(false)
    }
    // Created once, with no dependencies: path, value and readOnly are applied
    // by the effects below, because re-creating the editor would lose the
    // cursor, the scroll position and the undo history.
  }, [])

  // Swap the model when the focused file changes. One model per path, created
  // lazily and kept, so each tab keeps its own undo history and view state.
  useEffect(() => {
    const api = monaco.current
    const instance = editor.current
    if (!api || !instance || !ready) {
      return
    }
    const uri = api.Uri.parse(`workerdeck://host${path}`)
    const model = api.editor.getModel(uri) ?? api.editor.createModel(value, languageOf(path), uri)
    if (instance.getModel() !== model) {
      instance.setModel(model)
    }
  }, [path, ready, value])

  // Apply an external change (a reload, a revert) without disturbing anything
  // when the text already matches — most `value` changes echo the user's typing.
  useEffect(() => {
    const instance = editor.current
    if (!instance || !ready) {
      return
    }
    const model = instance.getModel()
    if (!model || model.getValue() === value) {
      return
    }
    // `pushEditOperations` rather than `setValue` so the replacement joins the
    // undo stack instead of clearing it.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null)
  }, [value, ready])

  useEffect(() => {
    if (ready) {
      editor.current?.updateOptions({ readOnly })
    }
  }, [readOnly, ready])

  // The theme is global to Monaco, not per-editor — `setTheme` is on the
  // namespace for that reason.
  useEffect(() => {
    if (ready) {
      monaco.current?.editor.setTheme(monacoTheme(theme))
    }
  }, [theme, ready])

  return (
    <div className={cn('relative min-h-0 min-w-0 flex-1', className)}>
      <div ref={host} className="absolute inset-0" />
      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center bg-bg">
          <Spinner className="size-4 text-fg-4" />
        </div>
      ) : null}
    </div>
  )
}

/** Follow the `data-theme` the design tokens swap on. An attribute observer
 * rather than a media query: the app has a manual toggle, and the attribute is
 * what that toggle writes. */
const useDocumentTheme = (): string | null => {
  const [theme, setTheme] = useState<string | null>(() =>
    typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme'),
  )
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setTheme(root.getAttribute('data-theme'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** An unset attribute means the host never opted into the token themes, in which
 * case dark matches this package's default surface. */
const monacoTheme = (theme: string | null): string => (theme === 'light' ? 'wd-light' : 'wd-dark')

/** Load Monaco once and hand back the API. Cached as a **promise**, so several
 * editors mounting in the same frame share one load instead of racing. */
let monacoPromise: Promise<typeof Monaco> | undefined
const loadMonaco = (): Promise<typeof Monaco> => {
  monacoPromise ??= (async () => {
    const api = await import('monaco-editor')
    // Transparent background so the editor inherits the surrounding surface
    // instead of Monaco's own near-black.
    api.editor.defineTheme('wd-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#00000000' },
    })
    api.editor.defineTheme('wd-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: { 'editor.background': '#00000000' },
    })
    return api
  })()
  return monacoPromise
}

/** Monaco's language id for a path; an unmatched file falls through to
 * `plaintext` rather than a guess. */
const languageOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const byName = FILENAME_LANGUAGES[name.toLowerCase()]
  if (byName) {
    return byName
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext'
}

/** Files whose type is their whole name. */
const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'shell',
}

/** Extension → Monaco language id. Only where the id differs from the extension
 * or the extension is ambiguous; everything else Monaco resolves itself. */
const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'plaintext',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  swift: 'swift',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  lua: 'lua',
  r: 'r',
  pl: 'perl',
  dart: 'dart',
  scala: 'scala',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  txt: 'plaintext',
  log: 'plaintext',
}
