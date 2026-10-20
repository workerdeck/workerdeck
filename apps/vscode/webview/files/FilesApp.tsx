import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import type { FileEntryKind, FilesToHost, HostToFiles, UploadedFile, WireDecoration, WireFilesRoot } from '../../src/bridge-protocol.ts'
import type { Bridge } from '../bridge.ts'
import { InlineInput } from './InlineInput.tsx'
import {
  flatten,
  folderFor,
  iconClasses,
  nameOf,
  rangeBetween,
  rowKey,
  ROW_HEIGHT,
  INDENT,
  validateName,
  type DirState,
  type Edit,
  type EntryRow,
  type Row,
} from './tree-model.ts'

type Theme = { css: string; fileIcons: boolean; folderIcons: boolean; hideArrows: boolean; modern: boolean }

type SavedState = { expanded?: Record<string, string[]> }

type Reveal = { uri: string; focus: boolean }

const TREE_MIME = 'application/vnd.workerdeck.files'
const OVERSCAN = 10
const DRAG_EXPAND_MS = 500
const PASTE_FALLBACK_MS = 60
const isMac = navigator.platform.toLowerCase().includes('mac')

export function FilesApp({ bridge }: { bridge: Bridge }) {
  const post = useCallback((msg: FilesToHost) => bridge.post(msg), [bridge])
  const [root, setRoot] = useState<WireFilesRoot | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [theme, setTheme] = useState<Theme>({ css: '', fileIcons: false, folderIcons: false, hideArrows: false, modern: false })
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [focused, setFocused] = useState<string | undefined>()
  const [anchor, setAnchor] = useState<string | undefined>()
  const [edit, setEdit] = useState<Edit | undefined>()
  const [decorations, setDecorations] = useState<Record<string, WireDecoration>>({})
  const [cut, setCut] = useState<Set<string>>(new Set())
  const [dropTarget, setDropTarget] = useState<string | undefined>()
  const [listFocused, setListFocused] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [reveal, setReveal] = useState<Reveal | undefined>()

  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requested = useRef(new Set<string>())
  const dragExpand = useRef<{ uri: string; timer: ReturnType<typeof setTimeout> } | undefined>(undefined)
  const pendingPaste = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const state = useRef({ root, dirs, expanded, focused, selected })
  state.current = { root, dirs, expanded, focused, selected }

  const request = useCallback(
    (uri: string) => {
      requested.current.add(uri)
      post({ kind: 'wd-files-list', uri })
    },
    [post],
  )

  const persistExpanded = useCallback(
    (rootUri: string, next: Set<string>) => {
      const saved = bridge.getState<SavedState>() ?? {}
      bridge.setState<SavedState>({ ...saved, expanded: { ...saved.expanded, [rootUri]: [...next] } })
    },
    [bridge],
  )

  const updateExpanded = useCallback(
    (change: (current: Set<string>) => Set<string>) => {
      setExpanded((current) => {
        const next = change(current)
        const rootUri = state.current.root?.uri
        if (rootUri) {
          persistExpanded(rootUri, next)
        }
        for (const uri of next) {
          if (!requested.current.has(uri)) {
            request(uri)
          }
        }
        return next
      })
    },
    [persistExpanded, request],
  )

  useEffect(
    () =>
      bridge.onHostMessage((raw) => {
        const msg = raw as HostToFiles
        switch (msg.kind) {
          case 'wd-files-root': {
            setMessage(msg.message)
            if (msg.root?.uri === state.current.root?.uri) {
              setRoot(msg.root)
              return
            }
            setRoot(msg.root)
            setDirs(new Map())
            setSelected(new Set())
            setFocused(undefined)
            setEdit(undefined)
            setCut(new Set())
            requested.current = new Set()
            if (msg.root) {
              const restored = new Set(bridge.getState<SavedState>()?.expanded?.[msg.root.uri] ?? [])
              setExpanded(restored)
              request(msg.root.uri)
              for (const uri of restored) {
                request(uri)
              }
            }
            return
          }
          case 'wd-files-dir': {
            setDirs((current) => new Map(current).set(msg.uri, { entries: msg.entries, error: msg.error }))
            return
          }
          case 'wd-files-refresh': {
            const { root: current, expanded: open } = state.current
            if (current) {
              requested.current = new Set()
              request(current.uri)
              for (const uri of open) {
                request(uri)
              }
            }
            return
          }
          case 'wd-files-theme': {
            setTheme({
              css: msg.css,
              fileIcons: msg.fileIcons,
              folderIcons: msg.folderIcons,
              hideArrows: msg.hideArrows,
              modern: msg.modern,
            })
            return
          }
          case 'wd-files-decorations': {
            setDecorations(msg.decorations)
            return
          }
          case 'wd-files-cut': {
            setCut(new Set(msg.uris))
            return
          }
          case 'wd-files-reveal': {
            updateExpanded((current) => new Set([...current, ...msg.ancestors]))
            setReveal({ uri: msg.uri, focus: msg.focus })
            return
          }
          case 'wd-files-command': {
            runCommand.current(msg.command, msg.uri)
            return
          }
          default: {
            return
          }
        }
      }),
    [bridge, request, updateExpanded],
  )

  const rows = useMemo(() => (root ? flatten(root.uri, dirs, expanded, edit) : []), [root, dirs, expanded, edit])
  const indexOf = useCallback((uri: string | undefined) => (uri ? rows.findIndex((r) => rowKey(r) === uri) : -1), [rows])


  const scrollIntoView = useCallback((index: number) => {
    const el = scrollRef.current
    if (!el || index < 0) {
      return
    }
    const top = index * ROW_HEIGHT
    if (top < el.scrollTop) {
      el.scrollTop = top
    } else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight
    }
  }, [])

  useEffect(() => {
    if (!reveal) {
      return
    }
    const index = indexOf(reveal.uri)
    if (index < 0) {
      return
    }
    setSelected(new Set([reveal.uri]))
    setFocused(reveal.uri)
    setAnchor(reveal.uri)
    scrollIntoView(index)
    if (reveal.focus) {
      listRef.current?.focus()
    }
    setReveal(undefined)
  }, [reveal, indexOf, scrollIntoView])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    setViewport(el.clientHeight)
    const observer = new ResizeObserver(() => setViewport(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [root])

  const focusRow = useCallback(
    (uri: string, extend: 'single' | 'range' | 'none' = 'single') => {
      setFocused(uri)
      if (extend === 'single') {
        setSelected(new Set([uri]))
        setAnchor(uri)
      } else if (extend === 'range') {
        setSelected(new Set(rangeBetween(rows, anchor ?? uri, uri)))
      }
      scrollIntoView(indexOf(uri))
    },
    [rows, anchor, indexOf, scrollIntoView],
  )

  const toggle = useCallback(
    (uri: string) => {
      updateExpanded((current) => {
        const next = new Set(current)
        if (next.has(uri)) {
          next.delete(uri)
        } else {
          next.add(uri)
        }
        return next
      })
    },
    [updateExpanded],
  )

  const selection = useCallback((): string[] => {
    if (selected.size > 0) {
      return rows.filter((r): r is EntryRow => r.kind === 'entry' && selected.has(r.entry.uri)).map((r) => r.entry.uri)
    }
    return focused ? [focused] : []
  }, [rows, selected, focused])

  const focusedRow = rows[indexOf(focused)]

  useEffect(() => {
    post({ kind: 'wd-files-selection', uris: selection() })
  }, [post, selection])

  useEffect(() => {
    post({ kind: 'wd-files-editing', editing: edit !== undefined })
  }, [post, edit])

  useEffect(() => {
    const report = () => post({ kind: 'wd-files-focus', focused: document.hasFocus() })
    report()
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    return () => {
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
    }
  }, [post])

  const startCreate = useCallback(
    (entry: FileEntryKind, uri?: string) => {
      const { root: current } = state.current
      if (!current) {
        return
      }
      const anchorRow = uri ? rows[indexOf(uri)] : focusedRow
      const parent = folderFor(anchorRow, current.uri)
      if (parent !== current.uri) {
        updateExpanded((open) => new Set([...open, parent]))
      }
      setEdit({ mode: 'create', parent, entry })
    },
    [rows, indexOf, focusedRow, updateExpanded],
  )

  const startRename = useCallback(
    (uri?: string) => {
      const target = uri ?? focused
      if (target && indexOf(target) >= 0) {
        focusRow(target)
        setEdit({ mode: 'rename', uri: target })
      }
    },
    [focused, indexOf, focusRow],
  )

  const runCommand = useRef<(command: string, uri?: string) => void>(() => {})
  runCommand.current = (command, uri) => {
    switch (command) {
      case 'newFile': {
        startCreate('file', uri)
        return
      }
      case 'newFolder': {
        startCreate('folder', uri)
        return
      }
      case 'rename': {
        startRename(uri)
        return
      }
      case 'collapseAll': {
        updateExpanded(() => new Set())
        return
      }
      default: {
        return
      }
    }
  }

  const open = useCallback(
    (uris: string[], mode: 'preview' | 'pinned' | 'side') => {
      const files = uris.filter((uri) => rows.some((r) => r.kind === 'entry' && r.entry.uri === uri && r.entry.kind === 'file'))
      if (files.length > 0) {
        post({ kind: 'wd-files-open', uris: files, mode })
      }
    },
    [rows, post],
  )

  const pasteTarget = useCallback(() => folderFor(focusedRow, state.current.root?.uri ?? ''), [focusedRow])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (edit || rows.length === 0) {
        return
      }
      const mod = isMac ? event.metaKey : event.ctrlKey
      const index = indexOf(focused)
      const row = rows[index]
      const entryRow = row?.kind === 'entry' ? row : undefined
      const handled = () => {
        event.preventDefault()
        event.stopPropagation()
      }
      const move = (to: number) => {
        const target = rows[Math.max(0, Math.min(rows.length - 1, to))]
        if (target) {
          focusRow(rowKey(target), event.shiftKey ? 'range' : 'single')
        }
      }
      const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1)
      const key = event.key
      if (key === 'ArrowDown' && mod && entryRow) {
        open([entryRow.entry.uri], 'pinned')
        return handled()
      }
      if (key === 'ArrowDown') {
        move(index < 0 ? 0 : index + 1)
        return handled()
      }
      if (key === 'ArrowUp') {
        move(index < 0 ? 0 : index - 1)
        return handled()
      }
      if (key === 'Home') {
        move(0)
        return handled()
      }
      if (key === 'End') {
        move(rows.length - 1)
        return handled()
      }
      if (key === 'PageDown') {
        move(index + page)
        return handled()
      }
      if (key === 'PageUp') {
        move(index - page)
        return handled()
      }
      if (key === 'ArrowRight' && entryRow?.entry.kind === 'folder') {
        if (!entryRow.expanded) {
          toggle(entryRow.entry.uri)
        } else {
          move(index + 1)
        }
        return handled()
      }
      if (key === 'ArrowLeft' && entryRow) {
        if (entryRow.expanded) {
          toggle(entryRow.entry.uri)
        } else if (entryRow.parent !== root?.uri) {
          focusRow(entryRow.parent)
        }
        return handled()
      }
      if (key === ' ' || (key === 'Enter' && !isMac && !mod)) {
        if (entryRow?.entry.kind === 'folder') {
          toggle(entryRow.entry.uri)
        } else {
          open(selection(), key === ' ' ? 'preview' : 'pinned')
        }
        return handled()
      }
      if (mod && !event.altKey && key.toLowerCase() === 'a') {
        setSelected(new Set(rows.filter((r): r is EntryRow => r.kind === 'entry').map((r) => r.entry.uri)))
        return handled()
      }
      if (mod && !event.altKey && key.toLowerCase() === 'v') {
        // Let the browser fire `paste`, which carries OS files; with none on it, fall back to the in-view clipboard.
        event.stopPropagation()
        const target = pasteTarget()
        clearTimeout(pendingPaste.current)
        pendingPaste.current = setTimeout(() => post({ kind: 'wd-files-paste', target }), PASTE_FALLBACK_MS)
        return
      }
      if (key === 'Escape') {
        setSelected(new Set())
        if (cut.size > 0) {
          post({ kind: 'wd-files-clipboard', uris: [], cut: false })
        }
        return handled()
      }
    },
    [edit, rows, indexOf, focused, viewport, focusRow, open, toggle, root, selection, post, pasteTarget, cut],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length === 0 || state.current.root === undefined || document.activeElement !== listRef.current) {
        return
      }
      clearTimeout(pendingPaste.current)
      event.preventDefault()
      void upload(post, pasteTarget(), files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [post, pasteTarget])

  const onRowMouseDown = useCallback(
    (event: MouseEvent, row: Row) => {
      if (row.kind !== 'entry' || edit) {
        return
      }
      if (event.button === 2 && !selected.has(row.entry.uri)) {
        focusRow(row.entry.uri)
      }
    },
    [edit, selected, focusRow],
  )

  const onRowClick = useCallback(
    (event: MouseEvent, row: Row) => {
      if (row.kind !== 'entry' || edit) {
        return
      }
      const uri = row.entry.uri
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (event.shiftKey) {
        focusRow(uri, 'range')
        return
      }
      if (mod) {
        setFocused(uri)
        setAnchor(uri)
        setSelected((current) => {
          const next = new Set(current)
          if (next.has(uri)) {
            next.delete(uri)
          } else {
            next.add(uri)
          }
          return next
        })
        return
      }
      focusRow(uri)
      if (row.entry.kind === 'folder') {
        toggle(uri)
      } else {
        open([uri], 'preview')
      }
    },
    [edit, focusRow, toggle, open],
  )

  const onRowDoubleClick = useCallback(
    (row: Row) => {
      if (row.kind === 'entry' && row.entry.kind === 'file') {
        open([row.entry.uri], 'pinned')
      }
    },
    [open],
  )

  const rowAt = useCallback(
    (target: EventTarget | null): Row | undefined => {
      const node = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-index]') : null
      return node ? rows[Number(node.dataset.index)] : undefined
    },
    [rows],
  )

  const onDragStart = useCallback(
    (event: DragEvent, row: Row) => {
      if (row.kind !== 'entry' || edit) {
        event.preventDefault()
        return
      }
      const uris = selected.has(row.entry.uri) ? selection() : [row.entry.uri]
      if (!selected.has(row.entry.uri)) {
        focusRow(row.entry.uri)
      }
      event.dataTransfer.effectAllowed = 'copyMove'
      event.dataTransfer.setData(TREE_MIME, JSON.stringify(uris))
      event.dataTransfer.setData('text/uri-list', uris.join('\r\n'))
      event.dataTransfer.setData('ResourceURLs', JSON.stringify(uris))
      if (root?.local) {
        event.dataTransfer.setData('CodeFiles', JSON.stringify(uris.map((u) => decodeURIComponent(new URL(u).pathname))))
      }
    },
    [edit, selected, selection, focusRow, root],
  )

  const clearDragExpand = () => {
    clearTimeout(dragExpand.current?.timer)
    dragExpand.current = undefined
  }

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!root) {
        return
      }
      event.preventDefault()
      const internal = event.dataTransfer.types.includes(TREE_MIME)
      event.dataTransfer.dropEffect = internal && !event.altKey ? 'move' : 'copy'
      const row = rowAt(event.target)
      const target = folderFor(row, root.uri)
      setDropTarget(target)
      if (row?.kind === 'entry' && row.entry.kind === 'folder' && !row.expanded) {
        if (dragExpand.current?.uri !== row.entry.uri) {
          clearDragExpand()
          const uri = row.entry.uri
          dragExpand.current = { uri, timer: setTimeout(() => toggle(uri), DRAG_EXPAND_MS) }
        }
      } else {
        clearDragExpand()
      }
    },
    [root, rowAt, toggle],
  )

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      clearDragExpand()
      setDropTarget(undefined)
      if (!root) {
        return
      }
      const target = folderFor(rowAt(event.target), root.uri)
      const internal = event.dataTransfer.getData(TREE_MIME)
      if (internal) {
        post({ kind: 'wd-files-move', uris: JSON.parse(internal) as string[], target, copy: event.altKey })
        return
      }
      const files = [...event.dataTransfer.files]
      if (files.length > 0) {
        void upload(post, target, files)
        return
      }
      const uris = (event.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter((line) => line && !line.startsWith('#'))
      if (uris.length > 0) {
        post({ kind: 'wd-files-drop-uris', target, uris })
      }
    },
    [root, rowAt, post],
  )

  const commitEdit = useCallback(
    (value: string) => {
      const current = edit
      setEdit(undefined)
      listRef.current?.focus()
      if (!current) {
        return
      }
      if (current.mode === 'create') {
        post({ kind: 'wd-files-create', parent: current.parent, name: value, entry: current.entry })
      } else if (value !== nameOf(current.uri)) {
        post({ kind: 'wd-files-rename', uri: current.uri, name: value })
      }
    },
    [edit, post],
  )

  const cancelEdit = useCallback(() => {
    setEdit(undefined)
    listRef.current?.focus()
  }, [])

  if (!root) {
    return (
      <div className="wdf">
        <p className="wdf-message">{message ?? ''}</p>
      </div>
    )
  }

  const rootState = dirs.get(root.uri)
  const activeGuide = focusedRow?.kind === 'entry' ? (focusedRow.expanded ? focusedRow.entry.uri : focusedRow.parent) : undefined
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const showIcons = theme.fileIcons || theme.folderIcons
  const treeClass = [
    'explorer-folders-view',
    'file-icon-themable-tree',
    showIcons ? 'show-file-icons' : '',
    theme.fileIcons && !theme.folderIcons ? 'align-icons-and-twisties' : '',
    theme.hideArrows ? 'hide-arrows' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const listClass = [
    'monaco-list',
    'mouse-support',
    selected.size > 1 ? 'selection-multiple' : 'selection-single',
    listFocused ? 'wdf-focused' : '',
    dropTarget === root.uri ? 'drop-target' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const dropRegion = dropTarget && dropTarget !== root.uri ? dropTarget : undefined

  return (
    <div className={theme.modern ? 'wdf wdf-modern' : 'wdf'} onContextMenu={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <style>{theme.css}</style>
      <div className={treeClass}>
        <div
          ref={listRef}
          className={listClass}
          tabIndex={0}
          role="tree"
          aria-label="Agent Files"
          aria-multiselectable="true"
          onKeyDown={onKeyDown}
          onFocus={() => setListFocused(true)}
          onBlur={() => setListFocused(false)}
          onDragOver={onDragOver}
          onDragLeave={(e) => {
            if (e.relatedTarget === null) {
              setDropTarget(undefined)
              clearDragExpand()
            }
          }}
          onDrop={onDrop}
          data-vscode-context={JSON.stringify({ webviewSection: 'root', preventDefaultContextMenuItems: true })}
        >
          <div ref={scrollRef} className="monaco-scrollable-element" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            {rootState?.error ? <p className="wdf-message">{rootState.error}</p> : null}
            <div className="monaco-list-rows" style={{ height: rows.length * ROW_HEIGHT }}>
              {rows.slice(start, end).map((row, offset) => {
                const index = start + offset
                const key = rowKey(row)
                const inDrop = dropRegion !== undefined && (key === dropRegion || row.ancestors.includes(dropRegion))
                return (
                  <TreeRow
                    key={key}
                    row={row}
                    index={index}
                    count={rows.length}
                    rootName={root.name}
                    selected={row.kind === 'entry' && selected.has(row.entry.uri)}
                    focused={key === focused}
                    dropTarget={inDrop}
                    cut={row.kind === 'entry' && cut.has(row.entry.uri)}
                    activeGuide={activeGuide}
                    decoration={row.kind === 'entry' ? decorations[row.entry.uri] : undefined}
                    edit={edit}
                    siblings={(dirs.get(row.parent)?.entries ?? []).map((e) => e.name)}
                    onMouseDown={onRowMouseDown}
                    onClick={onRowClick}
                    onDoubleClick={onRowDoubleClick}
                    onTwistie={toggle}
                    onDragStart={onDragStart}
                    onCommit={commitEdit}
                    onCancel={cancelEdit}
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

type TreeRowProps = {
  row: Row
  index: number
  count: number
  rootName: string
  selected: boolean
  focused: boolean
  dropTarget: boolean
  cut: boolean
  activeGuide: string | undefined
  decoration: WireDecoration | undefined
  edit: Edit | undefined
  siblings: string[]
  onMouseDown: (event: MouseEvent, row: Row) => void
  onClick: (event: MouseEvent, row: Row) => void
  onDoubleClick: (row: Row) => void
  onTwistie: (uri: string) => void
  onDragStart: (event: DragEvent, row: Row) => void
  onCommit: (value: string) => void
  onCancel: () => void
}

function TreeRow(props: TreeRowProps) {
  const { row, index, rootName, selected, focused, dropTarget, cut, activeGuide, decoration, edit } = props
  const isFolder = row.kind === 'entry' ? row.entry.kind === 'folder' : row.entry === 'folder'
  const editing = row.kind === 'create' || (edit?.mode === 'rename' && edit.uri === row.entry.uri)
  const name = row.kind === 'entry' ? row.entry.name : ''
  const parentName = row.ancestors.length > 0 ? nameOf(row.ancestors.at(-1)!) : rootName
  const icon = iconClasses(
    { name, kind: isFolder ? 'folder' : 'file', lang: row.kind === 'entry' ? row.entry.lang : undefined },
    parentName,
  )
  const twistie = isFolder
    ? `monaco-tl-twistie codicon codicon-tree-item-expanded collapsible${row.kind === 'entry' && row.expanded ? '' : ' collapsed'}`
    : 'monaco-tl-twistie'
  const rowClass = ['monaco-list-row', focused ? 'focused' : '', selected ? 'selected' : '', dropTarget ? 'drop-target' : '']
    .filter(Boolean)
    .join(' ')
  const labelClass = [
    'monaco-icon-label',
    ...icon,
    'explorer-item',
    cut ? 'cut' : '',
    editing ? 'explorer-item-edited' : '',
    decoration?.faded ? 'wdf-faded' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const context =
    row.kind === 'entry'
      ? JSON.stringify({ webviewSection: row.entry.kind, uri: row.entry.uri, preventDefaultContextMenuItems: true })
      : undefined
  const original = row.kind === 'entry' ? row.entry.name : undefined
  return (
    <div
      className={rowClass}
      role="treeitem"
      data-index={index}
      aria-level={row.level}
      aria-selected={selected}
      aria-expanded={isFolder && row.kind === 'entry' ? row.expanded : undefined}
      aria-setsize={props.count}
      aria-posinset={index + 1}
      aria-label={name}
      title={decoration?.tooltip ? `${name} • ${decoration.tooltip}` : undefined}
      draggable={!editing}
      style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px` }}
      data-vscode-context={context}
      onMouseDown={(e) => props.onMouseDown(e, row)}
      onClick={(e) => props.onClick(e, row)}
      onDoubleClick={() => props.onDoubleClick(row)}
      onDragStart={(e) => props.onDragStart(e, row)}
    >
      <div className="monaco-tl-row">
        <div className="monaco-tl-indent" style={{ width: (row.level - 1) * INDENT }}>
          {row.ancestors.map((ancestor) => (
            <div key={ancestor} className={ancestor === activeGuide ? 'indent-guide active' : 'indent-guide'} style={{ width: INDENT }} />
          ))}
        </div>
        <div
          className={twistie}
          style={{ paddingLeft: row.level * INDENT }}
          onClick={(e) => {
            if (isFolder && row.kind === 'entry') {
              e.stopPropagation()
              props.onTwistie(row.entry.uri)
            }
          }}
        />
        <div className="monaco-tl-contents">
          <div
            className={labelClass}
            style={{ display: 'flex', color: decoration?.color ? `var(--vscode-${decoration.color})` : undefined }}
            data-badge={editing ? undefined : decoration?.badge}
          >
            {editing ? (
              <InlineInput
                initial={original ?? ''}
                selectExtension={!isFolder}
                validate={(value) => validateName(value, props.siblings, original)}
                onCommit={props.onCommit}
                onCancel={props.onCancel}
              />
            ) : (
              <div className="monaco-icon-label-container">
                <span className="monaco-icon-name-container">
                  <a className="label-name">
                    <span className="monaco-highlighted-label">{name}</span>
                  </a>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

async function upload(post: (msg: FilesToHost) => void, target: string, files: File[]): Promise<void> {
  const read: UploadedFile[] = await Promise.all(
    files.map(async (file) => ({ name: file.name || 'pasted', b64: toBase64(new Uint8Array(await file.arrayBuffer())) })),
  )
  post({ kind: 'wd-files-upload', target, files: read })
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
