import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { WorkerDeckClient } from '@workerdeck/client'
import { useHostFileRoots, useHostFileSearch, useHostFileTree, useOpenFiles, useSessionInfo, isDirty } from '@workerdeck/react'
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
  /** Panel seams the workspace does not interpret, forwarded verbatim. Listed
   * rather than spread, so the workspace stays explicit about what it passes. */
  transcriptVariant?: SessionPanelProps['transcriptVariant']
  transcriptDensity?: SessionPanelProps['transcriptDensity']
  transcriptFont?: SessionPanelProps['transcriptFont']
  /** The overview ruler in place of the scrollbar — see `SessionPanel`. */
  scrubber?: SessionPanelProps['scrubber']
  scrubberMarks?: SessionPanelProps['scrubberMarks']
  /** The last prompt pinned above the transcript — see `SessionPanel`. */
  stickyPrompt?: SessionPanelProps['stickyPrompt']
  /** Take the panel body over with one sub-agent's work — see `SessionPanel`. */
  openSubagent?: SessionPanelProps['openSubagent']
  /** Travel to a row in the conversation without framing anything — where a
   * **task** press lands, as opposed to `openSubagent`'s takeover. See
   * `SessionPanel`. */
  reveal?: SessionPanelProps['reveal']
  /** The outward half of `openSubagent`: which sub-agent the panel now has
   * framed, or `undefined` for the conversation — see `SessionPanel`. */
  onSubagentChange?: SessionPanelProps['onSubagentChange']
  /** Which end of the panel the status bar sits at — see `SessionPanel`. */
  statusPlacement?: SessionPanelProps['statusPlacement']
  controlsSurface?: SessionPanelProps['controlsSurface']
  /** Base font size in whole pixels — see `SessionPanel.fontSize`. */
  fontSize?: SessionPanelProps['fontSize']
  /** Link click handler — see `SessionPanel.onLinkClick`. */
  onLinkClick?: SessionPanelProps['onLinkClick']
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
  /** The rail moved. Paired with the two defaults so an embedder can persist
   * the layout; the workspace deliberately does not. */
  onRailChange?: (rail: { width: number; collapsed: boolean }) => void
  className?: string
}

const RAIL_MIN = 180
const RAIL_MAX = 520
/** How little of the agent column the editor may leave — below this the
 * composer and a line of transcript stop fitting together. */
const AGENT_MIN = 220
const EDITOR_MIN = 120

/**
 * A VS Code-shaped workspace around a live session: file tree on the left, open
 * files above, the agent below. **Strictly additive** — {@link SessionPanel} is
 * still the whole session surface on its own.
 *
 * Two things are load-bearing and easy to break:
 *
 * 1. **The editor region is absent from the layout when nothing is open**, not
 *    collapsed to zero height, which would leave a draggable splitter behind.
 * 2. **`SessionPanel` keeps its position in the tree across that transition.**
 *    It holds the WebSocket attach and the entire transcript, so moving or
 *    conditionally wrapping it would remount it and drop the rendered history.
 *    The conditional children before it are `? :` expressions leaving a null in
 *    their slot, which is what keeps its index stable.
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
  openSubagent,
  reveal,
  onSubagentChange,
  statusPlacement,
  controlsSurface,
  fontSize,
  onLinkClick,
  unseen,
  readOnly,
  onVitals,
  defaultRailWidth = 260,
  defaultRailCollapsed,
  onRailChange,
  className,
}: SessionWorkspaceProps) {
  // The cwd comes from the registry, never off the panel's own session hook:
  // that would attach a second WebSocket client, and the tool bridge asks the
  // *first* attached client.
  const { info } = useSessionInfo(client, sessionId)
  const cwd = info?.cwd

  const tree = useHostFileTree(client, cwd)
  const search = useHostFileSearch(client, cwd)
  const files = useOpenFiles(client)
  // Writing is a separate server opt-in from reading and defaults off, so the
  // editor asks before it offers to save anything.
  const { canWrite } = useHostFileRoots(client)

  // Registered only while there is something to lose — an unconditional handler
  // makes every navigation prompt.
  useEffect(() => {
    if (!files.hasUnsaved) {
      return
    }
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [files.hasUnsaved])

  const wide = useIsWide()
  const [railCollapsed, setRailCollapsed] = useState(defaultRailCollapsed ?? false)
  const [railWidth, setRailWidth] = useState(defaultRailWidth)
  // In a ref so the effect below fires on a real change rather than on every
  // render an inline callback would cause.
  const onRailChangeRef = useRef(onRailChange)
  onRailChangeRef.current = onRailChange
  useEffect(() => {
    onRailChangeRef.current?.({ width: railWidth, collapsed: railCollapsed })
  }, [railWidth, railCollapsed])
  const [editorHeight, setEditorHeight] = useState(360)

  // Not reset when the last tab closes: reopening should restore the height the
  // user chose.
  const hasFiles = files.files.length > 0

  // A narrow viewport cannot spare 260px beside a transcript, so the rail
  // overlays the workspace instead of sitting next to it.
  const overlayRail = !wide
  const railOpen = tree.available && !railCollapsed
  useEffect(() => {
    if (overlayRail) {
      setRailCollapsed(true)
    }
  }, [overlayRail])

  // `confirm` rather than a styled dialog: a custom one would be a second modal
  // system inside a component an embedder already renders inside their own.
  const closeTab = useCallback(
    (path: string) => {
      const file = files.files.find((f) => f.path === path)
      if (file && isDirty(file)) {
        const name = file.name
        if (!window.confirm(`${name} has unsaved changes. Close it and lose them?`)) {
          return
        }
      }
      files.close(path)
    },
    [files],
  )

  const column = useRef<HTMLDivElement>(null)
  const columnHeight = useElementHeight(column)
  // The workspace is the only surface that *has* an editor, which is why the
  // path links live here and not in the panel. Monaco is excluded because
  // Cmd+click already means go-to-definition in there.
  const openPath = useCallback(({ path }: { path: string }) => files.open(resolveAgainstCwd(path, cwd)), [files.open, cwd])
  usePathLinks({
    container: column,
    onOpen: openPath,
    enabled: tree.available,
    ignore: '.monaco-editor',
  })
  const editorMax = Math.max(EDITOR_MIN, columnHeight - AGENT_MIN)

  // The embedder's header belongs above everything, but only `SessionPanel` can
  // build the `⋯` menu it is handed. So the panel still calls the render-prop in
  // its own tree and the result is portalled up here, keeping the menu's own
  // Base UI popup context intact.
  const [topBar, setTopBar] = useState<HTMLDivElement | null>(null)
  const hoisted: SessionPanelProps['header'] =
    header === undefined || topBar === null
      ? undefined
      : typeof header === 'function'
        ? (slots) => createPortal(header(slots), topBar)
        : createPortal(header, topBar)

  return (
    <div data-slot="session-workspace" className={cn('flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg', className)}>
      {header !== undefined ? <div ref={setTopBar} className="shrink-0" /> : null}
      <div className="relative flex min-h-0 flex-1">
        {railOpen ? (
          <FileTree
            tree={tree}
            search={search}
            activePath={files.activePath}
            onOpenFile={files.open}
            onCollapse={() => setRailCollapsed(true)}
            style={{ width: overlayRail ? Math.min(railWidth, 320) : railWidth }}
            className={cn('shrink-0 border-r border-border', overlayRail && 'absolute inset-y-0 left-0 z-20 shadow-lg')}
          />
        ) : tree.available ? (
          // In flow rather than floating, so it can never land on top of an
          // embedder's own header controls.
          <div className="flex w-8 shrink-0 flex-col items-center border-r border-border bg-surface pt-1.5">
            <Button variant="ghost" size="icon-sm" aria-label="Show project files" onClick={() => setRailCollapsed(false)}>
              <PanelLeftOpen className="size-4 text-fg-3" />
            </Button>
          </div>
        ) : null}
        {/* No splitter over an overlay rail — dragging a drawer's edge fights
          the scroll it sits on top of. */}
        {railOpen && !overlayRail ? (
          <Splitter
            orientation="vertical"
            value={railWidth}
            onValueChange={setRailWidth}
            min={RAIL_MIN}
            max={RAIL_MAX}
            defaultValue={defaultRailWidth}
            aria-label="Resize the file tree"
          />
        ) : null}

        <div ref={column} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Slot 1 of 3. The `? :` leaves a null here when nothing is open, which
            is what holds the agent's slot below and keeps it from remounting. */}
          {hasFiles ? (
            <div
              className="flex min-h-0 shrink-0 flex-col overflow-hidden"
              style={{ height: Math.min(editorHeight, editorMax || editorHeight) }}
            >
              <EditorTabs files={files.files} activePath={files.activePath} onActivate={files.activate} onClose={closeTab} />
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
              orientation="horizontal"
              value={Math.min(editorHeight, editorMax || editorHeight)}
              onValueChange={setEditorHeight}
              min={EDITOR_MIN}
              max={editorMax}
              aria-label="Resize the open file"
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
            openSubagent={openSubagent}
            reveal={reveal}
            onSubagentChange={onSubagentChange}
            controlsSurface={controlsSurface}
            fontSize={fontSize}
            onLinkClick={onLinkClick}
            statusPlacement={statusPlacement}
            unseen={unseen}
            readOnly={readOnly}
            onVitals={onVitals}
            className="min-h-0 flex-1"
          />
        </div>

        {/* Tapping away closes the drawer, which is the only way back to the
            transcript on a narrow screen. */}
        {overlayRail && railOpen ? (
          <button
            type="button"
            aria-label="Close the file tree"
            onClick={() => setRailCollapsed(true)}
            className="absolute inset-0 z-10 bg-black/30"
          />
        ) : null}
      </div>
    </div>
  )
}

/** Live height of an element, for a splitter that needs to know how much room
 * it is dividing. Zero until the first observation, which callers treat as
 * "unmeasured" rather than as a real bound. */
const useElementHeight = (ref: RefObject<HTMLElement | null>): number => {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setHeight(entry.contentRect.height)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return height
}

/** Whether there is room for a rail beside the content. Presentation only. */
const useIsWide = (): boolean => {
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
