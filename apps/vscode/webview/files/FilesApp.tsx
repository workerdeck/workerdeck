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
import type {
  FileEntryKind,
  FilesToHost,
  HostToFiles,
  UploadedFile,
  WireDecoration,
  WireFileEntry,
  WireFilesRoot,
} from '../../src/bridge-protocol.ts'
import type { Bridge } from '../bridge.ts'
import { InlineInput } from './InlineInput.tsx'
import {
  chainParent,
  flatten,
  folderFor,
  iconClasses,
  nameOf,
  rangeBetween,
  rowKey,
  ROW_HEIGHT,
  INDENT,
  soleFolder,
  validateName,
  type DirState,
  type Edit,
  type EntryRow,
  type Row,
} from './tree-model.ts'

type Theme = { css: string; fileIcons: boolean; folderIcons: boolean; hideArrows: boolean; modern: boolean; compact: boolean }

type SavedState = { expanded?: Record<string, string[]> }

type Reveal = { uri: string; focus: boolean }

type Segment = { row: string; index: number; size: number }

const TREE_MIME = 'application/vnd.workerdeck.files'
const OVERSCAN = 10
const DRAG_EXPAND_MS = 500
const PASTE_FALLBACK_MS = 60
const isMac = navigator.platform.toLowerCase().includes('mac')

export function FilesApp({ bridge }: { bridge: Bridge }) {
  const post = useCallback((msg: FilesToHost) => bridge.post(msg), [bridge])
  const [root, setRoot] = useState<WireFilesRoot | undefined>()
  const [message, setMessage] = useState<string | undefined>()
  const [theme, setTheme] = useState<Theme>({
    css: '',
    fileIcons: false,
    folderIcons: false,
    hideArrows: false,
    modern: false,
    compact: true,
  })
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
  const [segment, setSegment] = useState<Segment | undefined>()

  const listRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const requested = useRef(new Set<string>())
  const autoExpand = useRef(new Set<string>())
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
            setSegment(undefined)
            requested.current = new Set()
            autoExpand.current = new Set()
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
            if (autoExpand.current.delete(msg.uri)) {
              const only = soleFolder(msg.entries)
              if (only) {
                autoExpand.current.add(only.uri)
                updateExpanded((current) => new Set([...current, only.uri]))
              }
            }
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
              compact: msg.compact,
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
          case 'wd-files-moved': {
            updateExpanded((current) => new Set([...current].map((uri) => movedUri(uri, msg.moves))))
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

  const rows = useMemo(
    () => (root ? flatten(root.uri, dirs, expanded, edit, theme.compact) : []),
    [root, dirs, expanded, edit, theme.compact],
  )
  const rowIndex = useMemo(() => {
    const index = new Map<string, number>()
    rows.forEach((row, i) => {
      index.set(rowKey(row), i)
      if (row.kind === 'entry') {
        for (const member of row.chain) {
          index.set(member.uri, i)
        }
      }
    })
    return index
  }, [rows])
  const indexOf = useCallback((uri: string | undefined) => (uri ? (rowIndex.get(uri) ?? -1) : -1), [rowIndex])
  const activeIndex = useCallback(
    (row: EntryRow) => (segment?.row === rowKey(row) && segment.size === row.chain.length ? segment.index : row.chain.length - 1),
    [segment],
  )

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
    (uri: string, extend: 'single' | 'range' | 'none' = 'single', pick = false) => {
      const index = indexOf(uri)
      const row = rows[index]
      const key = row ? rowKey(row) : uri
      const member = pick && row?.kind === 'entry' ? row.chain.findIndex((e) => e.uri === uri) : -1
      setSegment(row?.kind === 'entry' && member >= 0 ? { row: key, index: member, size: row.chain.length } : undefined)
      setFocused(key)
      if (extend === 'single') {
        setSelected(new Set([key]))
        setAnchor(key)
      } else if (extend === 'range') {
        setSelected(new Set(rangeBetween(rows, anchor ?? key, key)))
      }
      scrollIntoView(index)
    },
    [rows, anchor, indexOf, scrollIntoView],
  )

  useEffect(() => {
    if (!reveal || indexOf(reveal.uri) < 0) {
      return
    }
    focusRow(reveal.uri, 'single', true)
    if (reveal.focus) {
      listRef.current?.focus()
    }
    setReveal(undefined)
  }, [reveal, indexOf, focusRow])

  // Opening also opens every lone subfolder below, as listings arrive: the Explorer's autoExpandSingleChildren.
  const toggle = useCallback(
    (uri: string) => {
      const row = rows[indexOf(uri)]
      const chain = row?.kind === 'entry' ? row.chain.map((e) => e.uri) : [uri]
      const last = chain.at(-1)!
      updateExpanded((current) => {
        const next = new Set(current)
        if (chain.every((member) => next.has(member))) {
          next.delete(last)
          return next
        }
        let tail = last
        for (const member of chain) {
          next.add(member)
        }
        let only = soleFolder(state.current.dirs.get(tail)?.entries)
        while (only) {
          tail = only.uri
          next.add(tail)
          only = soleFolder(state.current.dirs.get(tail)?.entries)
        }
        if (!state.current.dirs.has(tail)) {
          autoExpand.current.add(tail)
        }
        return next
      })
    },
    [rows, indexOf, updateExpanded],
  )

  const focusedRow = rows[indexOf(focused)]
  const focusedEntry = focusedRow?.kind === 'entry' ? focusedRow.chain[activeIndex(focusedRow)] : undefined

  const selection = useCallback((): string[] => {
    if (selected.size > 0) {
      return rows
        .filter((r): r is EntryRow => r.kind === 'entry' && selected.has(rowKey(r)))
        .map((r) => (rowKey(r) === focused && focusedEntry ? focusedEntry.uri : r.entry.uri))
    }
    return focusedEntry ? [focusedEntry.uri] : focused ? [focused] : []
  }, [rows, selected, focused, focusedEntry])

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
      const active = anchorRow?.kind === 'entry' ? (uri ? anchorRow.chain.find((e) => e.uri === uri) : focusedEntry) : undefined
      const parent = folderFor(anchorRow, current.uri, active)
      if (parent !== current.uri) {
        const chain = anchorRow?.kind === 'entry' ? anchorRow.chain.map((e) => e.uri) : []
        const through = chain.slice(0, chain.indexOf(parent) + 1)
        updateExpanded((open) => new Set([...open, ...through, parent]))
      }
      setEdit({ mode: 'create', parent, entry })
    },
    [rows, indexOf, focusedRow, focusedEntry, updateExpanded],
  )

  const startRename = useCallback(
    (uri?: string) => {
      const target = uri ?? focusedEntry?.uri ?? focused
      if (target && indexOf(target) >= 0) {
        focusRow(target, 'single', true)
        setEdit({ mode: 'rename', uri: target })
      }
    },
    [focused, focusedEntry, indexOf, focusRow],
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

  const pasteTarget = useCallback(() => folderFor(focusedRow, state.current.root?.uri ?? '', focusedEntry), [focusedRow, focusedEntry])

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
      const member = entryRow ? activeIndex(entryRow) : 0
      const lastMember = entryRow ? entryRow.chain.length - 1 : 0
      const toMember = (to: number) => {
        setSegment({ row: rowKey(entryRow!), index: to, size: lastMember + 1 })
        return handled()
      }
      if (lastMember > 0 && !event.shiftKey && !mod) {
        if (key === 'ArrowLeft' && member > 0) {
          return toMember(member - 1)
        }
        if (key === 'ArrowRight' && member < lastMember) {
          return toMember(member + 1)
        }
        if (key === 'Home' && member > 0) {
          return toMember(0)
        }
        if (key === 'End' && member < lastMember) {
          return toMember(lastMember)
        }
      }
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
        setSelected(new Set(rows.filter((r): r is EntryRow => r.kind === 'entry').map(rowKey)))
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
    [edit, rows, indexOf, focused, viewport, activeIndex, focusRow, open, toggle, root, selection, post, pasteTarget, cut],
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
      const key = rowKey(row)
      const member = memberAt(event.target, row)
      if (event.button === 2 && !selected.has(key)) {
        focusRow(member?.uri ?? key, 'single', member !== undefined)
      } else if (member) {
        setSegment({ row: key, index: row.chain.indexOf(member), size: row.chain.length })
      }
    },
    [edit, selected, focusRow],
  )

  const onRowClick = useCallback(
    (event: MouseEvent, row: Row) => {
      if (row.kind !== 'entry' || edit) {
        return
      }
      const uri = rowKey(row)
      const picked = memberAt(event.target, row)?.uri ?? (uri === focused ? focusedEntry?.uri : undefined)
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (event.shiftKey) {
        focusRow(picked ?? uri, 'range', picked !== undefined)
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
      focusRow(picked ?? uri, 'single', picked !== undefined)
      if (row.entry.kind === 'folder') {
        toggle(uri)
      } else {
        open([uri], 'preview')
      }
    },
    [edit, focused, focusedEntry, focusRow, toggle, open],
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
      const grabbed = memberAt(document.elementFromPoint(event.clientX, event.clientY), row)?.uri ?? row.entry.uri
      const uris = selected.has(rowKey(row)) && selected.size > 1 ? selection() : [grabbed]
      if (!selected.has(rowKey(row))) {
        focusRow(grabbed, 'single', true)
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

  const dropFolderAt = useCallback(
    (target: EventTarget | null): { row: Row | undefined; folder: string } => {
      const row = rowAt(target)
      return { row, folder: folderFor(row, root?.uri ?? '', row ? memberAt(target, row) : undefined) }
    },
    [rowAt, root],
  )

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!root) {
        return
      }
      event.preventDefault()
      const internal = event.dataTransfer.types.includes(TREE_MIME)
      event.dataTransfer.dropEffect = internal && !event.altKey ? 'move' : 'copy'
      const { row, folder } = dropFolderAt(event.target)
      setDropTarget(folder)
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
    [root, dropFolderAt, toggle],
  )

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      clearDragExpand()
      setDropTarget(undefined)
      if (!root) {
        return
      }
      const target = dropFolderAt(event.target).folder
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
    [root, dropFolderAt, post],
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
                const inDrop =
                  dropRegion !== undefined && ((row.kind === 'entry' && row.entry.uri === dropRegion) || row.ancestors.includes(dropRegion))
                return (
                  <TreeRow
                    key={key}
                    row={row}
                    index={index}
                    count={rows.length}
                    rootName={root.name}
                    selected={row.kind === 'entry' && selected.has(key)}
                    focused={key === focused}
                    active={row.kind === 'entry' ? activeIndex(row) : 0}
                    dropTarget={inDrop}
                    dropMember={dropTarget}
                    cut={row.kind === 'entry' && row.chain.some((e) => cut.has(e.uri))}
                    activeGuide={activeGuide}
                    decoration={row.kind === 'entry' ? decorations[row.entry.uri] : undefined}
                    edit={edit}
                    dirs={dirs}
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
  active: number
  dropTarget: boolean
  dropMember: string | undefined
  cut: boolean
  activeGuide: string | undefined
  decoration: WireDecoration | undefined
  edit: Edit | undefined
  dirs: ReadonlyMap<string, DirState>
  onMouseDown: (event: MouseEvent, row: Row) => void
  onClick: (event: MouseEvent, row: Row) => void
  onDoubleClick: (row: Row) => void
  onTwistie: (uri: string) => void
  onDragStart: (event: DragEvent, row: Row) => void
  onCommit: (value: string) => void
  onCancel: () => void
}

function TreeRow(props: TreeRowProps) {
  const { row, index, rootName, selected, focused, active, dropTarget, dropMember, cut, activeGuide, decoration, edit } = props
  const isFolder = row.kind === 'entry' ? row.entry.kind === 'folder' : row.entry === 'folder'
  const chain = row.kind === 'entry' ? row.chain : []
  const renaming = edit?.mode === 'rename' ? chain.findIndex((e) => e.uri === edit.uri) : -1
  const editing = row.kind === 'create' || renaming >= 0
  const name = row.kind === 'entry' ? row.entry.name : ''
  const parentName = chain.length > 1 ? chain.at(-2)!.name : row.ancestors.length > 0 ? nameOf(row.ancestors.at(-1)!) : rootName
  const editParent = row.kind === 'entry' && renaming >= 0 ? chainParent(row, renaming) : row.parent
  const siblings = (props.dirs.get(editParent)?.entries ?? []).map((e) => e.name)
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
  const original = renaming >= 0 ? chain[renaming]!.name : undefined
  const multiple = chain.length > 1
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
      aria-label={chain.map((e) => e.name).join('/') || name}
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
                validate={(value) => validateName(value, siblings, original)}
                onCommit={props.onCommit}
                onCancel={props.onCancel}
              />
            ) : (
              <div className="monaco-icon-label-container">
                <span className={multiple ? 'monaco-icon-name-container multiple' : 'monaco-icon-name-container'}>
                  {multiple ? (
                    chain.map((member, i) => (
                      <a
                        key={member.uri}
                        className={[
                          'label-name',
                          i === (focused ? active : chain.length - 1) ? 'active' : '',
                          member.uri === dropMember && i < chain.length - 1 ? 'drop-target' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        data-icon-label-count={chain.length}
                        data-icon-label-index={i}
                        data-vscode-context={JSON.stringify({
                          webviewSection: 'folder',
                          uri: member.uri,
                          preventDefaultContextMenuItems: true,
                        })}
                      >
                        <span className="monaco-highlighted-label">{member.name}</span>
                        {i < chain.length - 1 ? <span className="label-separator">/</span> : null}
                      </a>
                    ))
                  ) : (
                    <a className="label-name">
                      <span className="monaco-highlighted-label">{name}</span>
                    </a>
                  )}
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

function memberAt(target: EventTarget | null, row: Row): WireFileEntry | undefined {
  const label = target instanceof Element ? target.closest<HTMLElement>('[data-icon-label-index]') : null
  return label && row.kind === 'entry' ? row.chain[Number(label.dataset.iconLabelIndex)] : undefined
}

function movedUri(uri: string, moves: readonly { from: string; to: string }[]): string {
  const move = moves.find(({ from }) => uri === from || uri.startsWith(`${from}/`))
  return move ? move.to + uri.slice(move.from.length) : uri
}
