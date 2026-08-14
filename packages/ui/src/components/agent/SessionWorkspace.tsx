import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  useHostFileRoots,
  useHostFileSearch,
  useHostFileTree,
  useOpenFiles,
  useSessionInfo,
  isDirty,
} from '@workerdeck/react'
import { PanelLeftOpen } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Splitter } from '../ui/Splitter.tsx'
import { EditorTabs } from './EditorTabs.tsx'
import { FileTree } from './FileTree.tsx'
import { FileViewer } from './FileViewer.tsx'
import { SessionPanel, type SessionPanelProps } from './SessionPanel.tsx'
import { resolveAgainstCwd, usePathLinks } from './use-path-links.ts'

export interface SessionWorkspaceProps {
  client: WorkerDeckClient
  sessionId: string | undefined
  /** Passed straight through to {@link SessionPanel} — including the render-prop
   * form that claims the session-actions menu. */
  header?: SessionPanelProps['header']
  /**
   * Panel seams the workspace does not interpret, forwarded verbatim.
   *
   * They are listed rather than spread so the workspace stays explicit about
   * what it passes on: the panel owns the session's one attach, and a seam that
   * silently arrived here would be a second place to look for why a session
   * renders the way it does.
   */
  transcriptVariant?: SessionPanelProps['transcriptVariant']
  transcriptDensity?: SessionPanelProps['transcriptDensity']
  transcriptFont?: SessionPanelProps['transcriptFont']
  /** The overview ruler in place of the scrollbar — see `SessionPanel`. */
  scrubber?: SessionPanelProps['scrubber']
  scrubberMarks?: SessionPanelProps['scrubberMarks']
  /** The last prompt pinned above the transcript — see `SessionPanel`. */
  stickyPrompt?: SessionPanelProps['stickyPrompt']
  /** Which end of the panel the status bar sits at — see `SessionPanel`. */
  statusPlacement?: SessionPanelProps['statusPlacement']
  controlsSurface?: SessionPanelProps['controlsSurface']
  unseen?: SessionPanelProps['unseen']
  /** Viewer mode — no composer, no approval prompts. Forwarded verbatim to
   * {@link SessionPanel}; the file tree and editor are unaffected, since reading
   * a run's files is the point of a read-only view. */
  readOnly?: SessionPanelProps['readOnly']
  onVitals?: SessionPanelProps['onVitals']
  /** Rail width in pixels on first render. */
  defaultRailWidth?: number
  /** Start with the file rail collapsed even on a wide viewport. */
  defaultRailCollapsed?: boolean
  /**
   * The rail moved. Paired with the two defaults so an embedder can persist the
   * layout — the workspace deliberately does not, because *where* to keep it (a
   * Memento, localStorage, a workspace file) is the embedder's call, and a
   * component that picked one would be wrong in the other hosts.
   */
  onRailChange?: (rail: { width: number; collapsed: boolean }) => void
  className?: string
}

const RAIL_MIN = 180
const RAIL_MAX = 520
/** How little of the agent column the editor may leave. Below this the composer
 * and a line of transcript stop fitting together, which is the point at which the
 * agent has stopped being usable rather than merely small. */
const AGENT_MIN = 220
const EDITOR_MIN = 120

/**
 * A VS Code-shaped workspace around a live session: file tree on the left, open
 * files above, the agent below.
 *
 * **Strictly additive.** {@link SessionPanel} is untouched and still the whole
 * session surface on its own — an embedder picks one or the other, and one that
 * has its own file tree keeps using the panel.
 *
 * Two things here are load-bearing and easy to break:
 *
 * 1. **The editor region is absent from the layout when nothing is open**, not
 *    collapsed to zero height. A zero-height pane leaves a draggable splitter and
 *    parks the composer at an odd offset; absence is what makes the agent's
 *    "claims the full column" state actually look like the panel alone.
 * 2. **`SessionPanel` keeps its position in the tree across that transition.** It
 *    holds the WebSocket attach and the entire transcript, so moving it between
 *    parents — or wrapping it conditionally — would remount it and drop the
 *    session's rendered history on the floor the first time someone opens a file.
 *    The conditional children before it are `? :` expressions that leave a null in
 *    their slot, which is exactly what keeps its index stable.
 */
export function SessionWorkspace({
  client,
  sessionId,
  header,
  transcriptVariant,
  transcriptDensity,
  transcriptFont,
  scrubber,
  scrubberMarks,
  stickyPrompt,
  statusPlacement,
  controlsSurface,
  unseen,
  readOnly,
  onVitals,
  defaultRailWidth = 260,
  defaultRailCollapsed,
  onRailChange,
  className,
}: SessionWorkspaceProps) {
  // The cwd is the tree's root, and it comes from the registry rather than from
  // the panel: reading it off the panel's own session hook would mean attaching
  // a second WebSocket client, and the tool bridge asks the *first* attached
  // client — a second one changes who answers.
  const { info } = useSessionInfo(client, sessionId)
  const cwd = info?.cwd

  const tree = useHostFileTree(client, cwd)
  const search = useHostFileSearch(client, cwd)
  const files = useOpenFiles(client)
  // Writing is a separate server opt-in from reading and defaults off, so the
  // editor asks before it offers to save anything.
  const { canWrite } = useHostFileRoots(client)


  // Nothing here can save on the user's behalf when the tab is going away, so
  // the browser's own guard is the last line. Registered only while there is
  // something to lose — an unconditional handler makes every navigation prompt.
  useEffect(() => {
    if (!files.hasUnsaved) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [files.hasUnsaved])

  const wide = useIsWide()
  const [railCollapsed, setRailCollapsed] = useState(defaultRailCollapsed ?? false)
  const [railWidth, setRailWidth] = useState(defaultRailWidth)
  // Reported rather than stored. Kept in a ref so the effect below fires on a
  // real change instead of on every render an inline callback would cause.
  const onRailChangeRef = useRef(onRailChange)
  onRailChangeRef.current = onRailChange
  useEffect(() => {
    onRailChangeRef.current?.({ width: railWidth, collapsed: railCollapsed })
  }, [railWidth, railCollapsed])
  const [editorHeight, setEditorHeight] = useState(360)

  // Closing every tab returns the agent to the full column; opening one again
  // should restore the height the user had chosen, so this is not reset here.
  const hasFiles = files.files.length > 0

  // A narrow viewport cannot spare 260px of rail beside a transcript, so there
  // the rail overlays the workspace instead of sitting next to it — and starts
  // out of the way.
  const overlayRail = !wide
  const railOpen = tree.available && !railCollapsed
  useEffect(() => {
    if (overlayRail) setRailCollapsed(true)
  }, [overlayRail])

  // Closing a dirty tab is the one destructive thing the strip can do, and the
  // edits are not recoverable once the tab is gone. `confirm` rather than a
  // styled dialog on purpose: it is modal, it cannot be missed, and a
  // custom one here would be a second modal system inside a component an
  // embedder already renders inside their own.
  const closeTab = useCallback(
    (path: string) => {
      const file = files.files.find((f) => f.path === path)
      if (file && isDirty(file)) {
        const name = file.name
        if (!window.confirm(`${name} has unsaved changes. Close it and lose them?`)) return
      }
      files.close(path)
    },
    [files],
  )

  const column = useRef<HTMLDivElement>(null)
  const columnHeight = useElementHeight(column)
  // Cmd/Ctrl+click a file the agent named and it opens in the editor above —
  // the workspace is the only surface that *has* an editor, which is why this
  // lives here and not in the panel. Gated on the tree being available: without
  // a host filesystem there is nothing to open, and a link that cannot resolve
  // is worse than plain text. Monaco is excluded because Cmd+click already
  // means go-to-definition in there, and every identifier would match.
  const openPath = useCallback(
    ({ path }: { path: string }) => files.open(resolveAgainstCwd(path, cwd)),
    [files.open, cwd],
  )
  usePathLinks({
    container: column,
    onOpen: openPath,
    enabled: tree.available,
    ignore: '.monaco-editor',
  })
  const editorMax = Math.max(EDITOR_MIN, columnHeight - AGENT_MIN)

  // The embedder's header is app chrome and belongs above everything — but only
  // `SessionPanel` can *build* the `⋯` menu it is handed, and only if it is the
  // one calling the render-prop. So the panel still calls it, in its own tree,
  // and the result is portalled up here. That keeps `SessionPanel` untouched and
  // keeps the menu's own context (it is a Base UI popup) intact.
  const [topBar, setTopBar] = useState<HTMLDivElement | null>(null)
  const hoisted: SessionPanelProps['header'] =
    header === undefined || topBar === null
      ? undefined
      : typeof header === 'function'
        ? (slots) => createPortal(header(slots), topBar)
        : createPortal(header, topBar)

  return (
    <div
      data-slot='session-workspace'
      className={cn('flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg', className)}>
      {header !== undefined ? <div ref={setTopBar} className='shrink-0' /> : null}
      <div className='relative flex min-h-0 flex-1'>
      {railOpen ? (
        <FileTree
          tree={tree}
          search={search}
          activePath={files.activePath}
          onOpenFile={files.open}
          onCollapse={() => setRailCollapsed(true)}
          style={{ width: overlayRail ? Math.min(railWidth, 320) : railWidth }}
          className={cn(
            'shrink-0 border-r border-border',
            overlayRail && 'absolute inset-y-0 left-0 z-20 shadow-lg',
          )}
        />
      ) : tree.available ? (
        // Collapsed: a slim strip that keeps the rail one click away. In flow
        // rather than floating over the panel, so it can never land on top of an
        // embedder's own header controls.
        <div className='flex w-8 shrink-0 flex-col items-center border-r border-border bg-surface pt-1.5'>
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label='Show project files'
            onClick={() => setRailCollapsed(false)}>
            <PanelLeftOpen className='size-4 text-fg-3' />
          </Button>
        </div>
      ) : null}
      {/* No splitter over an overlay rail — dragging a drawer's edge on a phone
          fights the scroll it is sitting on top of. */}
      {railOpen && !overlayRail ? (
        <Splitter
          orientation='vertical'
          value={railWidth}
          onValueChange={setRailWidth}
          min={RAIL_MIN}
          max={RAIL_MAX}
          defaultValue={defaultRailWidth}
          aria-label='Resize the file tree'
        />
      ) : null}

      <div ref={column} className='flex min-h-0 min-w-0 flex-1 flex-col'>
        {/* Slot 1 of 3. The `? :` leaves a null here when nothing is open, which
            is what holds the agent's slot below and keeps it from remounting. */}
        {hasFiles ? (
          <div
            className='flex min-h-0 shrink-0 flex-col overflow-hidden'
            style={{ height: Math.min(editorHeight, editorMax || editorHeight) }}>
            <EditorTabs
              files={files.files}
              activePath={files.activePath}
              onActivate={files.activate}
              onClose={closeTab}
            />
            <FileViewer
              file={files.active}
              canWrite={canWrite}
              onChange={files.edit}
              onSave={(path) => void files.save(path)}
              onRevert={files.revert}
              onReload={files.reload}
              onOverwrite={(path) => void files.overwrite(path)}
              onDismissConflict={files.dismissConflict}
            />
          </div>
        ) : null}
        {/* Slot 2 of 3. */}
        {hasFiles ? (
          <Splitter
            orientation='horizontal'
            value={Math.min(editorHeight, editorMax || editorHeight)}
            onValueChange={setEditorHeight}
            min={EDITOR_MIN}
            max={editorMax}
            aria-label='Resize the open file'
          />
        ) : null}
        {/* Slot 3 of 3 — always here, always at this index. */}
        <SessionPanel
          client={client}
          sessionId={sessionId}
          header={hoisted}
          transcriptVariant={transcriptVariant}
          transcriptDensity={transcriptDensity}
          transcriptFont={transcriptFont}
          scrubber={scrubber}
          scrubberMarks={scrubberMarks}
          stickyPrompt={stickyPrompt}
          controlsSurface={controlsSurface}
          statusPlacement={statusPlacement}
          unseen={unseen}
          readOnly={readOnly}
          onVitals={onVitals}
          className='min-h-0 flex-1'
        />
      </div>

        {/* Tapping away closes the drawer, which is the only way back to the
            transcript on a narrow screen. */}
        {overlayRail && railOpen ? (
          <button
            type='button'
            aria-label='Close the file tree'
            onClick={() => setRailCollapsed(true)}
            className='absolute inset-0 z-10 bg-black/30'
          />
        ) : null}
      </div>
    </div>
  )
}

/** Live height of an element, for a splitter that needs to know how much room it
 * is dividing. Zero until the first observation, which callers treat as
 * "unmeasured" rather than as a real bound. */
function useElementHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setHeight(entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return height
}

/** Whether there is room for a rail beside the content. Presentation only — the
 * workspace's actual state lives in the hooks from `@workerdeck/react`. */
function useIsWide(): boolean {
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)')
    const sync = () => setWide(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return wide
}
