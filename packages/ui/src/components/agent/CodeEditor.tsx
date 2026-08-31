import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { cn } from '../../lib/utils.ts'
import { Spinner } from '../ui/Spinner.tsx'

export interface CodeEditorProps {
  path: string
  value: string
  onChange?: (value: string) => void
  onSave?: () => void
  readOnly?: boolean
  className?: string
}

export function CodeEditor({ path, value, onChange, onSave, readOnly, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const monaco = useRef<typeof Monaco | null>(null)
  const [ready, setReady] = useState(false)
  const theme = useDocumentTheme()

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
      // The editor, never its models: a model is keyed by path and outlives this mount, which is what restores a reopened tab's undo stack.
      editor.current?.dispose()
      editor.current = null
      setReady(false)
    }
  }, [])

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

  useEffect(() => {
    const instance = editor.current
    if (!instance || !ready) {
      return
    }
    const model = instance.getModel()
    if (!model || model.getValue() === value) {
      return
    }
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null)
  }, [value, ready])

  useEffect(() => {
    if (ready) {
      editor.current?.updateOptions({ readOnly })
    }
  }, [readOnly, ready])

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

function monacoTheme(theme: string | null): string {
  return theme === 'light' ? 'wd-light' : 'wd-dark'
}

let monacoPromise: Promise<typeof Monaco> | undefined
function loadMonaco(): Promise<typeof Monaco> {
  monacoPromise ??= (async () => {
    const api = await import('monaco-editor')
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

function languageOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const byName = FILENAME_LANGUAGES[name.toLowerCase()]
  if (byName) {
    return byName
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext'
}

const FILENAME_LANGUAGES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'plaintext',
  '.gitignore': 'plaintext',
  '.env': 'shell',
}

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
