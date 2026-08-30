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
 * Monaco — VS Code's own editor — behind a small React surface.
 *
 * Two deliberate choices, both about `@workerdeck/ui` being a **published
 * library** rather than an app:
 *
 * 1. **Loaded on demand.** The `import()` is inside an effect, so Monaco is a
 *    separate chunk that arrives when someone first opens a file. A dashboard
 *    that never opens one never pays for it, and Monaco's ~90 language grammars
 *    are themselves lazy (each `registerLanguage` carries an `import()` loader),
 *    so opening a `.ts` file fetches the TypeScript grammar and nothing else.
 * 2. **No `MonacoEnvironment` is configured here, and none is needed.** Workers
 *    in a library become every embedder's bootstrapping problem, and
 *    `packages/web` ships prebuilt static files at a domain root, which is
 *    exactly where hardcoded worker URLs break. The editor is configured so it
 *    never asks for one: `wordBasedSuggestions` and `quickSuggestions` off,
 *    no diff editor. A host that wants the worker-backed language services
 *    (TypeScript IntelliSense, JSON schema validation) sets `MonacoEnvironment`
 *    itself before the first file is opened — Monaco is a singleton and nothing
 *    here fights that.
 *
 * One model per path, kept across tab switches, so undo history and view state
 * survive clicking away and back — which is most of what makes tabs feel like
 * tabs rather than like re-opening a file.
 */
export function CodeEditor({ path, value, onChange, onSave, readOnly, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monaco = useRef<typeof Monaco | null>(null)
  const [ready, setReady] = useState(false)
  const theme = useDocumentTheme()

  // Callbacks through refs: they change identity every render, and re-creating
  // the editor (or re-registering its listeners) on each one would drop the
  // cursor mid-keystroke.
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
        // Without a worker there is no word-based suggestion provider to ask, so
        // asking would surface an empty popup on every identifier.
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
    // Deliberately created once, with no dependencies. Path, value and readOnly
    // are applied by the effects below instead, because re-creating the editor
    // to change any of them would lose the cursor, the scroll position and the
    // undo history.
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

  // Apply an external change — a reload from disk, a revert — without
  // disturbing anything when the text already matches, which is the common case
  // because most changes to `value` are echoes of the user's own typing.
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

/**
 * Follow the `data-theme` the design tokens already swap on, so the editor is
 * never the one light rectangle in a dark app (or the reverse). An attribute
 * observer rather than a media query: the app has a manual toggle, and the
 * attribute is what that toggle writes.
 */
function useDocumentTheme(): string | null {
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
function monacoTheme(theme: string | null): string {
  return theme === 'light' ? 'wd-light' : 'wd-dark'
}

/**
 * Load Monaco once, register the themes, and hand back the API.
 *
 * Cached as a promise rather than a value so that several editors mounting in
 * the same frame share one load instead of racing three of them.
 */
let monacoPromise: Promise<typeof Monaco> | undefined
function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= (async () => {
    const api = await import('monaco-editor')
    // Themes that inherit the surrounding surface instead of Monaco's own
    // near-black, so the editor does not sit in the layout as a differently
    // coloured rectangle. Both are defined; the CSS variable decides nothing
    // here, so the panel picks by `prefers-color-scheme` on the document.
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

/**
 * Monaco's language id for a path.
 *
 * By extension, with a short table for the files that have none — Monaco's own
 * registry is keyed on extensions it knows, and an unmatched file falls through
 * to `plaintext`, which is the honest answer rather than a guess.
 */
function languageOf(path: string): string {
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
