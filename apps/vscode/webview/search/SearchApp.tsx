import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { replacementFor, type HostSearchFile, type HostSearchMatch, type ReplaceOptions } from '@workerdeck/protocol'
import { matchKey, matchPreview, useHostSearch, type HostSearchQuery } from '@workerdeck/react'
import type {
  FileOpenMode,
  HostToSearch,
  SearchCommand,
  SearchToHost,
  WireReplaceFile,
  WireSearchRoot,
  WireSearchSettings,
} from '../../src/bridge-protocol.ts'
import type { Bridge } from '../bridge.ts'
import { languageOf, type LanguageIndex } from '../../src/language-of.ts'
import { iconClasses } from '../files/tree-model.ts'
import { runOverBridge } from './bridge-run.ts'
import {
  dirOf,
  nameOf,
  noResultsText,
  parentKey,
  replacedText,
  resultCountText,
  resultRows,
  type Collapse,
  type FileRow,
  type FolderRow,
  type MatchRow,
  type ResultRow,
} from './results-model.ts'

type Saved = {
  query?: HostSearchQuery
  showReplace?: boolean
  showDetails?: boolean
  tree?: boolean
  history?: Partial<Record<HistoryField, string[]>>
}

type HistoryField = 'query' | 'replace' | 'includes' | 'excludes'

type Toggle = { icon: string; title: string; checked: boolean; onToggle: () => void }

const ROW_HEIGHT = 22
const INDENT = 8
const OVERSCAN = 10
const HISTORY_LIMIT = 100
const isMac = navigator.platform.toLowerCase().includes('mac')
const MOD = isMac ? '⌥⌘' : 'Alt+'

const DEFAULT_SETTINGS: WireSearchSettings = {
  excludes: [],
  searchOnType: true,
  debounceMs: 300,
  maxResults: 20_000,
  viewMode: 'list',
  collapseResults: 'alwaysExpand',
  lineNumbers: false,
}

export function SearchApp({ bridge }: { bridge: Bridge }) {
  const post = useCallback((msg: SearchToHost) => bridge.post(msg), [bridge])
  const saved = useMemo(() => bridge.getState<Saved>() ?? {}, [bridge])
  const [root, setRoot] = useState<WireSearchRoot | undefined>()
  const [rootMessage, setRootMessage] = useState<string | undefined>()
  const [settings, setSettings] = useState<WireSearchSettings>(DEFAULT_SETTINGS)
  const [theme, setTheme] = useState<{ css: string; fileIcons: boolean; languages?: LanguageIndex }>({ css: '', fileIcons: false })
  const [showReplace, setShowReplace] = useState(saved.showReplace === true)
  const [showDetails, setShowDetails] = useState(saved.showDetails === true)
  const [tree, setTree] = useState<boolean | undefined>(saved.tree)
  const [history, setHistory] = useState<Partial<Record<HistoryField, string[]>>>(saved.history ?? {})
  const [collapse, setCollapse] = useState<Collapse>({ all: false, mode: 'alwaysExpand', overrides: new Map() })
  const [focused, setFocused] = useState<string | undefined>()
  const [notice, setNotice] = useState<string | undefined>()
  const searchInput = useRef<HTMLTextAreaElement>(null)
  const replaceInput = useRef<HTMLTextAreaElement>(null)
  const includesInput = useRef<HTMLTextAreaElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const run = useCallback(
    (request: Parameters<typeof runOverBridge>[1], signal: AbortSignal) => runOverBridge(bridge, request, signal),
    [bridge],
  )
  const search = useHostSearch({
    root: root?.canSearch ? root.path : undefined,
    run,
    settingsExcludes: settings.excludes,
    searchOnType: settings.searchOnType,
    debounceMs: settings.debounceMs,
    maxResults: settings.maxResults,
    initialQuery: saved.query,
  })
  const { query, setQuery, state, counts } = search
  const treeMode = tree ?? settings.viewMode === 'tree'
  const replaceActive = showReplace

  const handlers = useRef<(msg: HostToSearch) => void>(() => {})
  useEffect(() => bridge.onHostMessage((msg) => handlers.current(msg as HostToSearch)), [bridge])

  handlers.current = (msg: HostToSearch) => {
    switch (msg.kind) {
      case 'wd-search-root': {
        setRoot(msg.root)
        setRootMessage(msg.message)
        return
      }
      case 'wd-search-settings': {
        setSettings(msg.settings)
        setCollapse((previous) => ({ ...previous, mode: msg.settings.collapseResults }))
        return
      }
      case 'wd-search-theme': {
        setTheme({
          css: msg.css,
          fileIcons: msg.fileIcons,
          languages: { names: new Map(Object.entries(msg.languages.names)), extensions: new Map(Object.entries(msg.languages.extensions)) },
        })
        return
      }
      case 'wd-search-command': {
        runCommand(msg.command, msg.seed)
        return
      }
      case 'wd-search-replaced': {
        const matches = msg.files.reduce((sum, file) => sum + file.matches.length, 0)
        search.dismissMatches(msg.files.map((file) => ({ path: file.path, keys: file.matches.map(matchKey) })))
        if (matches > 0) {
          setNotice(replacedText(matches, msg.files.length, query.replace))
        }
        return
      }
      case 'wd-search-events': {
        return
      }
    }
  }

  function runCommand(command: SearchCommand, seed?: { query?: string; includes?: string }): void {
    switch (command) {
      case 'focus':
      case 'replace': {
        if (seed?.query !== undefined) {
          setQuery({ query: seed.query })
        }
        if (seed?.includes !== undefined) {
          setQuery({ includes: seed.includes })
          setShowDetails(true)
        }
        if (command === 'replace') {
          setShowReplace(true)
          requestAnimationFrame(() => replaceInput.current?.focus())
        }
        requestAnimationFrame(() => {
          if (command === 'focus') {
            searchInput.current?.focus()
            searchInput.current?.select()
          }
        })
        return
      }
      case 'refresh': {
        search.search()
        return
      }
      case 'clear': {
        search.clear()
        setNotice(undefined)
        searchInput.current?.focus()
        return
      }
      case 'viewAsTree': {
        setTree(true)
        return
      }
      case 'viewAsList': {
        setTree(false)
        return
      }
      case 'collapseAll': {
        setCollapse((previous) => ({ ...previous, all: true, overrides: new Map() }))
        return
      }
      case 'expandAll': {
        setCollapse((previous) => ({ ...previous, all: false, mode: 'alwaysExpand', overrides: new Map() }))
        return
      }
      case 'replaceAll': {
        replaceFiles(state.files, true)
        return
      }
      case 'toggleCase': {
        setQuery({ matchCase: !query.matchCase })
        return
      }
      case 'toggleWord': {
        setQuery({ wholeWord: !query.wholeWord })
        return
      }
      case 'toggleRegex': {
        setQuery({ isRegex: !query.isRegex })
        return
      }
      case 'togglePreserveCase': {
        setQuery({ preserveCase: !query.preserveCase })
        return
      }
    }
  }

  useEffect(() => {
    bridge.setState<Saved>({ query, showReplace, showDetails, tree, history })
  }, [bridge, query, showReplace, showDetails, tree, history])

  useEffect(() => {
    if (state.status === 'searching') {
      setCollapse((previous) => ({ ...previous, all: false, mode: settings.collapseResults, overrides: new Map() }))
      setNotice(undefined)
    }
  }, [state.status, state.run, settings.collapseResults])

  useEffect(() => {
    if (state.status !== 'done' || query.query === '') {
      return
    }
    const value = query.query
    const timer = setTimeout(() => remember('query', value), 1000)
    return () => clearTimeout(timer)
  }, [state.status, state.run, query.query])

  const rows = useMemo(() => resultRows(state.files, treeMode, collapse), [state.files, treeMode, collapse])

  useEffect(() => {
    post({
      kind: 'wd-search-view',
      tree: treeMode,
      collapsed: collapse.all,
      hasResults: state.files.length > 0,
      hasQuery: query.query !== '',
    })
  }, [post, treeMode, collapse.all, state.files.length, query.query])

  function remember(field: HistoryField, value: string): void {
    if (!value) {
      return
    }
    setHistory((previous) => {
      const kept = (previous[field] ?? []).filter((entry) => entry !== value)
      return { ...previous, [field]: [...kept, value].slice(-HISTORY_LIMIT) }
    })
  }

  const replaceOptions = (): ReplaceOptions => ({
    query: query.query,
    replace: query.replace,
    isRegex: query.isRegex,
    matchCase: query.matchCase,
    preserveCase: query.preserveCase,
  })

  function replaceFiles(files: readonly HostSearchFile[], confirm: boolean): void {
    const wire: WireReplaceFile[] = files.map((file) => ({ path: file.path, matches: file.lines.flatMap((line) => line.matches) }))
    if (wire.length === 0) {
      return
    }
    remember('replace', query.replace)
    post({ kind: 'wd-search-replace', options: replaceOptions(), files: wire, confirm })
  }

  function replaceMatch(file: HostSearchFile, match: HostSearchMatch): void {
    remember('replace', query.replace)
    post({ kind: 'wd-search-replace', options: replaceOptions(), files: [{ path: file.path, matches: [match] }], confirm: false })
  }

  function dismiss(row: ResultRow): void {
    if (row.kind === 'match') {
      search.dismissMatch(row.file.path, matchKey(row.match))
      return
    }
    const files = row.kind === 'file' ? [row.file] : row.files
    search.dismissMatches(files.map((file) => ({ path: file.path, keys: file.lines.flatMap((line) => line.matches.map(matchKey)) })))
  }

  function open(row: ResultRow, mode: FileOpenMode): void {
    if (row.kind === 'folder') {
      return
    }
    if (row.kind === 'match' && replaceActive) {
      post({
        kind: 'wd-search-preview',
        options: replaceOptions(),
        file: { path: row.file.path, matches: row.file.lines.flatMap((l) => l.matches) },
        range: row.match,
      })
      return
    }
    const range = row.kind === 'match' ? row.match : row.file.lines[0]?.matches[0]
    post({ kind: 'wd-search-open', path: row.file.path, range, mode })
  }

  function toggleRow(row: ResultRow, collapsed?: boolean): void {
    if (row.kind === 'match') {
      return
    }
    setCollapse((previous) => {
      const overrides = new Map(previous.overrides)
      overrides.set(row.key, collapsed ?? !row.collapsed)
      return { ...previous, overrides }
    })
  }

  function inputKeys(field: HistoryField, value: string, ref: RefObject<HTMLTextAreaElement | null>) {
    return (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const input = e.currentTarget
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        remember(field, value)
        if (field === 'replace' && state.files.length > 0) {
          replaceFiles(state.files, true)
          return
        }
        search.search()
        return
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey) {
        e.preventDefault()
        const { selectionStart, selectionEnd } = input
        const next = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`
        setQuery({ [field]: next } as Partial<HostSearchQuery>)
        requestAnimationFrame(() => ref.current?.setSelectionRange(selectionStart + 1, selectionStart + 1))
        return
      }
      if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && rows.length > 0) {
        e.preventDefault()
        setFocused(rows[0]!.key)
        list.current?.focus()
        return
      }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const atStart = !value.slice(0, input.selectionStart).includes('\n')
        const atEnd = !value.slice(input.selectionEnd).includes('\n')
        if ((e.key === 'ArrowUp' && !atStart) || (e.key === 'ArrowDown' && !atEnd)) {
          return
        }
        const entries = history[field] ?? []
        if (entries.length === 0) {
          return
        }
        e.preventDefault()
        const at = entries.lastIndexOf(value)
        const index = e.key === 'ArrowUp' ? (at === -1 ? entries.length - 1 : Math.max(0, at - 1)) : at === -1 ? -1 : at + 1
        const next = index >= 0 && index < entries.length ? entries[index]! : ''
        if (at === -1 && e.key === 'ArrowDown') {
          return
        }
        setQuery({ [field]: next } as Partial<HostSearchQuery>)
      }
    }
  }

  const focusHandlers = (input: boolean) => ({
    onFocus: () => post({ kind: 'wd-search-focus', focused: true, input }),
    onBlur: () => post({ kind: 'wd-search-focus', focused: false }),
  })

  const searching = state.status === 'searching'
  const noRoot = !root
  const unavailable = root && !root.canSearch

  return (
    <div className={`wds search-view ${theme.fileIcons ? 'show-file-icons' : ''}`} {...focusHandlers(false)} tabIndex={-1}>
      <style>{theme.css}</style>
      <div className={`monaco-progress-container ${searching ? 'active infinite' : 'done'}`}>
        <div className="progress-bit" />
      </div>
      {noRoot || unavailable ? (
        <p className="wds-message">
          {noRoot
            ? (rootMessage ?? 'Select a session to search its folder.')
            : 'Search is not available on this gateway: ripgrep was not found.'}
        </p>
      ) : (
        <>
          <div className="search-widgets-container">
            <div className="search-widget">
              <div
                className={`toggle-replace-button codicon ${showReplace ? 'codicon-chevron-down' : 'codicon-chevron-right'}`}
                role="button"
                aria-label="Toggle Replace"
                title="Toggle Replace"
                tabIndex={0}
                onClick={() => setShowReplace((v) => !v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setShowReplace((v) => !v)
                  }
                }}
              />
              <div className="search-container input-box">
                <FindInput
                  inputRef={searchInput}
                  value={query.query}
                  placeholder="Search"
                  ariaLabel="Search"
                  error={state.status === 'error' ? state.error : undefined}
                  onChange={(value) => setQuery({ query: value })}
                  onKeyDown={inputKeys('query', query.query, searchInput)}
                  {...focusHandlers(true)}
                  toggles={[
                    {
                      icon: 'case-sensitive',
                      title: `Match Case (${MOD}C)`,
                      checked: query.matchCase,
                      onToggle: () => setQuery({ matchCase: !query.matchCase }),
                    },
                    {
                      icon: 'whole-word',
                      title: `Match Whole Word (${MOD}W)`,
                      checked: query.wholeWord,
                      onToggle: () => setQuery({ wholeWord: !query.wholeWord }),
                    },
                    {
                      icon: 'regex',
                      title: `Use Regular Expression (${MOD}R)`,
                      checked: query.isRegex,
                      onToggle: () => setQuery({ isRegex: !query.isRegex }),
                    },
                  ]}
                />
              </div>
              {showReplace ? (
                <div className="replace-container">
                  <FindInput
                    inputRef={replaceInput}
                    value={query.replace}
                    placeholder="Replace"
                    ariaLabel="Replace"
                    onChange={(value) => setQuery({ replace: value })}
                    onKeyDown={inputKeys('replace', query.replace, replaceInput)}
                    {...focusHandlers(true)}
                    toggles={[
                      {
                        icon: 'preserve-case',
                        title: `Preserve Case (${MOD}P)`,
                        checked: query.preserveCase,
                        onToggle: () => setQuery({ preserveCase: !query.preserveCase }),
                      },
                    ]}
                  />
                  <div className="monaco-action-bar">
                    <ul className="actions-container">
                      <li className="action-item">
                        <a
                          className={`action-label codicon codicon-replace-all ${state.files.length === 0 ? 'disabled' : ''}`}
                          role="button"
                          title={`Replace All (${isMac ? '⌥⌘Enter' : 'Ctrl+Alt+Enter'})`}
                          aria-disabled={state.files.length === 0}
                          onClick={() => {
                            if (state.files.length > 0) {
                              replaceFiles(state.files, true)
                            }
                          }}
                        />
                      </li>
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
            <div className={`query-details ${showDetails ? 'more' : ''}`}>
              <a
                className="more codicon codicon-ellipsis"
                role="button"
                title="Toggle Search Details"
                aria-expanded={showDetails}
                tabIndex={0}
                onClick={() => {
                  setShowDetails((v) => !v)
                  if (!showDetails) {
                    requestAnimationFrame(() => includesInput.current?.focus())
                  }
                }}
              />
              {showDetails ? (
                <>
                  <div className="file-types includes">
                    <h4>files to include</h4>
                    <FindInput
                      inputRef={includesInput}
                      value={query.includes}
                      placeholder="e.g. *.ts, src/**/include"
                      ariaLabel="files to include"
                      onChange={(value) => setQuery({ includes: value })}
                      onKeyDown={inputKeys('includes', query.includes, includesInput)}
                      {...focusHandlers(true)}
                      toggles={[]}
                    />
                  </div>
                  <div className="file-types excludes">
                    <h4>files to exclude</h4>
                    <FindInput
                      value={query.excludes}
                      placeholder="e.g. *.ts, src/**/exclude"
                      ariaLabel="files to exclude"
                      onChange={(value) => setQuery({ excludes: value })}
                      onKeyDown={inputKeys('excludes', query.excludes, includesInput)}
                      {...focusHandlers(true)}
                      toggles={[
                        {
                          icon: 'exclude',
                          title: 'Use Exclude Settings and Ignore Files',
                          checked: query.useIgnoreFiles,
                          onToggle: () => setQuery({ useIgnoreFiles: !query.useIgnoreFiles }),
                        },
                      ]}
                    />
                  </div>
                </>
              ) : null}
            </div>
          </div>
          <Messages
            status={state.status}
            hasQuery={query.query !== ''}
            counts={counts}
            truncated={state.truncated}
            error={state.error}
            notice={notice}
            includes={query.includes}
            excludes={query.excludes}
            onOpenSettings={() => post({ kind: 'wd-search-open-settings' })}
          />
          <Results
            listRef={list}
            rows={rows}
            focused={focused}
            setFocused={setFocused}
            replaceActive={replaceActive}
            options={replaceOptions()}
            lineNumbers={settings.lineNumbers}
            treeMode={treeMode}
            onOpen={open}
            onToggle={toggleRow}
            onDismiss={dismiss}
            onReplace={(row) => {
              if (row.kind === 'match') {
                replaceMatch(row.file, row.match)
              } else {
                replaceFiles(row.kind === 'file' ? [row.file] : row.files, false)
              }
            }}
            onCopy={(text) => post({ kind: 'wd-search-copy', text })}
            focusHandlers={focusHandlers(false)}
            languages={theme.languages}
          />
        </>
      )}
    </div>
  )
}

type FindInputProps = {
  value: string
  placeholder: string
  ariaLabel: string
  toggles: Toggle[]
  error?: string
  inputRef?: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onFocus: () => void
  onBlur: () => void
}

function FindInput({ value, placeholder, ariaLabel, toggles, error, inputRef, onChange, onKeyDown, onFocus, onBlur }: FindInputProps) {
  const [focused, setFocused] = useState(false)
  const lines = Math.min(value.split('\n').length, 10)
  return (
    <div className={`monaco-findInput ${focused ? 'synthetic-focus' : ''} ${error ? 'error' : ''}`}>
      <div className={`monaco-inputbox ${error ? 'error' : 'idle'}`}>
        <div className="ibwrapper">
          <textarea
            ref={inputRef}
            className="input"
            aria-label={ariaLabel}
            placeholder={placeholder}
            value={value}
            rows={lines}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            wrap="off"
            style={{ paddingRight: toggles.length * 22 + 6, height: lines * 18 }}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              setFocused(true)
              onFocus()
            }}
            onBlur={() => {
              setFocused(false)
              onBlur()
            }}
          />
        </div>
      </div>
      {toggles.length > 0 ? (
        <div className="controls">
          {toggles.map((toggle) => (
            <div
              key={toggle.icon}
              className={`monaco-custom-toggle codicon codicon-${toggle.icon} ${toggle.checked ? 'checked' : 'unchecked'}`}
              role="checkbox"
              aria-checked={toggle.checked}
              aria-label={toggle.title}
              title={toggle.title}
              tabIndex={0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggle.onToggle}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggle.onToggle()
                }
              }}
            />
          ))}
        </div>
      ) : null}
      {error && focused ? <div className="monaco-inputbox-message error">{error}</div> : null}
    </div>
  )
}

type MessagesProps = {
  status: string
  hasQuery: boolean
  counts: { files: number; matches: number }
  truncated: boolean
  error?: string
  notice?: string
  includes: string
  excludes: string
  onOpenSettings: () => void
}

function Messages({ status, hasQuery, counts, truncated, error, notice, includes, excludes, onOpenSettings }: MessagesProps) {
  let body: ReactNode = null
  if (notice) {
    body = <p>{notice}</p>
  } else if (status === 'error' && error) {
    body = <p className="wds-error">{error}</p>
  } else if (status === 'done' && hasQuery && counts.matches === 0) {
    body = (
      <p>
        {noResultsText(includes.trim(), excludes.trim())}
        <a className="pointer prominent" role="button" tabIndex={0} onClick={onOpenSettings}>
          Open Settings
        </a>
      </p>
    )
  } else if ((status === 'done' || status === 'searching') && counts.matches > 0) {
    body = (
      <>
        {truncated ? (
          <p>The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.</p>
        ) : null}
        <p>{resultCountText(counts.matches, counts.files)}</p>
      </>
    )
  }
  if (!body) {
    return null
  }
  return (
    <div className="messages text-search-provider-messages">
      <div className="message">{body}</div>
    </div>
  )
}

type ResultsProps = {
  listRef: RefObject<HTMLDivElement | null>
  rows: ResultRow[]
  focused: string | undefined
  setFocused: (key: string | undefined) => void
  replaceActive: boolean
  options: ReplaceOptions
  lineNumbers: boolean
  treeMode: boolean
  onOpen: (row: ResultRow, mode: FileOpenMode) => void
  onToggle: (row: ResultRow, collapsed?: boolean) => void
  onDismiss: (row: ResultRow) => void
  onReplace: (row: ResultRow) => void
  onCopy: (text: string) => void
  focusHandlers: { onFocus: () => void; onBlur: () => void }
  languages?: LanguageIndex
}

function Results(props: ResultsProps) {
  const { listRef, rows, focused, setFocused, onOpen, onToggle, onDismiss } = props
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)
  const [listFocused, setListFocused] = useState(false)

  useLayoutEffect(() => {
    const element = listRef.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    setHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [listRef])

  const focusIndex = focused ? rows.findIndex((row) => row.key === focused) : -1

  useEffect(() => {
    if (focused && focusIndex === -1 && rows.length > 0) {
      setFocused(undefined)
    }
  }, [focused, focusIndex, rows.length, setFocused])

  const reveal = useCallback(
    (index: number) => {
      const element = listRef.current
      if (!element) {
        return
      }
      const top = index * ROW_HEIGHT
      if (top < element.scrollTop) {
        element.scrollTop = top
      } else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW_HEIGHT - element.clientHeight
      }
    },
    [listRef],
  )

  function move(index: number): void {
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    const row = rows[clamped]
    if (row) {
      setFocused(row.key)
      reveal(clamped)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    const row = rows[focusIndex]
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1)
    switch (e.key) {
      case 'ArrowDown': {
        move(focusIndex + 1)
        break
      }
      case 'ArrowUp': {
        move(focusIndex === -1 ? 0 : focusIndex - 1)
        break
      }
      case 'PageDown': {
        move(focusIndex + page)
        break
      }
      case 'PageUp': {
        move(focusIndex - page)
        break
      }
      case 'Home': {
        move(0)
        break
      }
      case 'End': {
        move(rows.length - 1)
        break
      }
      case 'ArrowLeft': {
        if (row && row.kind !== 'match' && !row.collapsed) {
          onToggle(row, true)
        } else {
          const parent = parentKey(rows, focusIndex)
          if (parent) {
            move(rows.findIndex((r) => r.key === parent))
          }
        }
        break
      }
      case 'ArrowRight': {
        if (row && row.kind !== 'match') {
          if (row.collapsed) {
            onToggle(row, false)
          } else {
            move(focusIndex + 1)
          }
        }
        break
      }
      case 'Enter': {
        if (row) {
          if (row.kind === 'folder') {
            onToggle(row)
          } else {
            onOpen(row, e.metaKey || e.ctrlKey ? 'side' : 'pinned')
          }
        }
        break
      }
      case ' ': {
        if (row) {
          if (row.kind === 'match') {
            onOpen(row, 'preview')
          } else {
            onToggle(row)
          }
        }
        break
      }
      case 'Delete':
      case 'Backspace': {
        if (row && (e.key === 'Delete' || e.metaKey)) {
          onDismiss(row)
        } else {
          return
        }
        break
      }
      case 'c': {
        if (row && (e.metaKey || e.ctrlKey)) {
          props.onCopy(rowText(row))
        } else {
          return
        }
        break
      }
      default: {
        return
      }
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)
  const visible = rows.slice(first, last)

  return (
    <div className="results show-file-icons">
      <div
        ref={listRef}
        className={`monaco-list mouse-support ${listFocused && focused ? 'element-focused' : ''}`}
        role="tree"
        aria-label="Search Results"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => {
          setListFocused(true)
          props.focusHandlers.onFocus()
        }}
        onBlur={() => {
          setListFocused(false)
          props.focusHandlers.onBlur()
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="monaco-list-rows" style={{ height: rows.length * ROW_HEIGHT }}>
          {visible.map((row, offset) => (
            <Row
              key={row.key}
              row={row}
              top={(first + offset) * ROW_HEIGHT}
              focused={row.key === focused}
              props={props}
              onFocusRow={() => setFocused(row.key)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function rowText(row: ResultRow): string {
  if (row.kind === 'match') {
    return `  ${row.match.line + 1},${row.match.column + 1}: ${row.line.text.trim()}`
  }
  if (row.kind === 'file') {
    return [row.file.path, ...row.file.lines.map((line) => `  ${line.line + 1}: ${line.text.trim()}`)].join('\n')
  }
  return row.files.map((file) => file.path).join('\n')
}

function Row({
  row,
  top,
  focused,
  props,
  onFocusRow,
}: {
  row: ResultRow
  top: number
  focused: boolean
  props: ResultsProps
  onFocusRow: () => void
}) {
  const collapsible = row.kind !== 'match'
  const onClick = (e: MouseEvent) => {
    onFocusRow()
    if ((e.target as HTMLElement).closest('.monaco-action-bar')) {
      return
    }
    if (row.kind === 'folder') {
      props.onToggle(row)
      return
    }
    if (row.kind === 'file' && (e.target as HTMLElement).closest('.monaco-tl-twistie')) {
      props.onToggle(row)
      return
    }
    props.onOpen(row, e.altKey || e.metaKey || e.ctrlKey ? 'side' : 'preview')
  }
  return (
    <div
      className={`monaco-list-row ${focused ? 'focused selected' : ''}`}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={collapsible ? !row.collapsed : undefined}
      style={{ top, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
      onMouseDown={(e) => e.detail > 1 && e.preventDefault()}
      onClick={onClick}
      onDoubleClick={() => {
        if (row.kind !== 'folder') {
          props.onOpen(row, 'pinned')
        }
      }}
    >
      <div className="monaco-tl-row">
        <div
          className={`monaco-tl-twistie ${collapsible ? 'collapsible codicon codicon-tree-item-expanded' : ''} ${collapsible && row.collapsed ? 'collapsed' : ''}`}
          style={{ paddingLeft: row.depth * INDENT }}
          onClick={(e) => {
            if (collapsible) {
              e.stopPropagation()
              onFocusRow()
              props.onToggle(row)
            }
          }}
        />
        <div className="monaco-tl-contents">
          {row.kind === 'folder' ? (
            <FolderContent row={row} props={props} />
          ) : row.kind === 'file' ? (
            <FileContent row={row} props={props} />
          ) : (
            <MatchContent row={row} props={props} />
          )}
        </div>
      </div>
    </div>
  )
}

function Actions({ replace, row, props }: { replace?: 'replace' | 'replace-all'; row: ResultRow; props: ResultsProps }) {
  return (
    <div className="monaco-action-bar">
      <ul className="actions-container">
        {replace && props.replaceActive ? (
          <li className="action-item">
            <a
              className={`action-label codicon codicon-${replace}`}
              role="button"
              title={replace === 'replace' ? 'Replace' : 'Replace All'}
              onClick={(e) => {
                e.stopPropagation()
                props.onReplace(row)
              }}
            />
          </li>
        ) : null}
        <li className="action-item">
          <a
            className="action-label codicon codicon-close"
            role="button"
            title="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              props.onDismiss(row)
            }}
          />
        </li>
      </ul>
    </div>
  )
}

function Badge({ count }: { count: number }) {
  return (
    <div className="badge">
      <span className="monaco-count-badge long" title={count === 1 ? '1 match' : `${count} matches`}>
        {count}
      </span>
    </div>
  )
}

function FolderContent({ row, props }: { row: FolderRow; props: ResultsProps }) {
  const name = nameOf(row.path)
  return (
    <div className="foldermatch">
      <div className={`monaco-icon-label ${iconClasses({ name, kind: 'folder' }, nameOf(dirOf(row.path))).join(' ')}`} title={row.path}>
        <div className="monaco-icon-label-container">
          <span className="monaco-icon-name-container">
            <a className="label-name">{row.name}</a>
          </span>
        </div>
      </div>
      <Badge count={row.matches} />
      <Actions replace="replace-all" row={row} props={props} />
    </div>
  )
}

function FileContent({ row, props }: { row: FileRow; props: ResultsProps }) {
  const name = nameOf(row.file.relative)
  const dir = dirOf(row.file.relative)
  return (
    <div className="filematch" title={row.file.path}>
      <div
        className={`monaco-icon-label ${iconClasses({ name, kind: 'file', lang: props.languages && languageOf(props.languages, name) }, nameOf(dir)).join(' ')}`}
      >
        <div className="monaco-icon-label-container">
          <span className="monaco-icon-name-container">
            <a className="label-name">{name}</a>
          </span>
          {!props.treeMode && dir ? (
            <span className="monaco-icon-description-container">
              <span className="label-description">{dir}</span>
            </span>
          ) : null}
        </div>
      </div>
      <Badge count={row.matches} />
      <Actions replace="replace-all" row={row} props={props} />
    </div>
  )
}

function MatchContent({ row, props }: { row: MatchRow; props: ResultsProps }) {
  const preview = matchPreview(row.line, row.match)
  const replacement = props.replaceActive ? replacementFor(row.match.text, props.options) : undefined
  const multiline = row.match.endLine > row.match.line
  return (
    <div className="linematch" title={`${row.line.text.trim()}`}>
      {props.lineNumbers ? <span className="matchLineNum show">{`${row.match.line + 1}:`}</span> : null}
      <span className="match">
        {preview.trimmed ? '…' : ''}
        {preview.before}
        <span className={`findInFileMatch ${replacement !== undefined ? 'replace' : ''}`}>{preview.match}</span>
        {replacement !== undefined ? <span className="replaceMatch">{replacement}</span> : null}
        {multiline ? '↵' : preview.after}
      </span>
      <Actions replace="replace" row={row} props={props} />
    </div>
  )
}
