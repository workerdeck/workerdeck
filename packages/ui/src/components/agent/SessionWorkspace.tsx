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
  header?: SessionPanelProps['header']
  transcriptVariant?: SessionPanelProps['transcriptVariant']
  transcriptDensity?: SessionPanelProps['transcriptDensity']
  transcriptFont?: SessionPanelProps['transcriptFont']
  midTurnSend?: SessionPanelProps['midTurnSend']
  scrubber?: SessionPanelProps['scrubber']
  bookmarks?: SessionPanelProps['bookmarks']
  onToggleBookmark?: SessionPanelProps['onToggleBookmark']
  stickyPrompt?: SessionPanelProps['stickyPrompt']
  openSubagent?: SessionPanelProps['openSubagent']
  reveal?: SessionPanelProps['reveal']
  onSubagentChange?: SessionPanelProps['onSubagentChange']
  statusPlacement?: SessionPanelProps['statusPlacement']
  controlsSurface?: SessionPanelProps['controlsSurface']
  fontSize?: SessionPanelProps['fontSize']
  onLinkClick?: SessionPanelProps['onLinkClick']
  unseen?: SessionPanelProps['unseen']
  readOnly?: SessionPanelProps['readOnly']
  onVitals?: SessionPanelProps['onVitals']
  defaultRailWidth?: number
  defaultRailCollapsed?: boolean
  onRailChange?: (rail: { width: number; collapsed: boolean }) => void
  className?: string
}

const RAIL_MIN = 180
const RAIL_MAX = 520
const AGENT_MIN = 220
const EDITOR_MIN = 120

export function SessionWorkspace({
  client,
  sessionId,
  header,
  transcriptVariant,
  transcriptDensity,
  transcriptFont,
  midTurnSend,
  scrubber,
  bookmarks,
  onToggleBookmark,
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
  const { info } = useSessionInfo(client, sessionId)
  const cwd = info?.cwd

  const tree = useHostFileTree(client, cwd)
  const search = useHostFileSearch(client, cwd)
  const files = useOpenFiles(client)
  const { canWrite } = useHostFileRoots(client)

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
  const onRailChangeRef = useRef(onRailChange)
  onRailChangeRef.current = onRailChange
  useEffect(() => {
    onRailChangeRef.current?.({ width: railWidth, collapsed: railCollapsed })
  }, [railWidth, railCollapsed])
  const [editorHeight, setEditorHeight] = useState(360)

  const hasFiles = files.files.length > 0

  const overlayRail = !wide
  const railOpen = tree.available && !railCollapsed
  useEffect(() => {
    if (overlayRail) {
      setRailCollapsed(true)
    }
  }, [overlayRail])

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
  const openPath = useCallback(({ path }: { path: string }) => files.open(resolveAgainstCwd(path, cwd)), [files.open, cwd])
  usePathLinks({
    container: column,
    onOpen: openPath,
    enabled: tree.available,
    ignore: '.monaco-editor',
  })
  const editorMax = Math.max(EDITOR_MIN, columnHeight - AGENT_MIN)

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
          <div className="flex w-8 shrink-0 flex-col items-center border-r border-border bg-surface pt-1.5">
            <Button variant="ghost" size="icon-sm" aria-label="Show project files" onClick={() => setRailCollapsed(false)}>
              <PanelLeftOpen className="size-4 text-fg-3" />
            </Button>
          </div>
        ) : null}
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
          <SessionPanel
            client={client}
            sessionId={sessionId}
            header={hoisted}
            transcriptVariant={transcriptVariant}
            transcriptDensity={transcriptDensity}
            transcriptFont={transcriptFont}
            midTurnSend={midTurnSend}
            scrubber={scrubber}
            bookmarks={bookmarks}
            onToggleBookmark={onToggleBookmark}
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

function useElementHeight(ref: RefObject<HTMLElement | null>): number {
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
