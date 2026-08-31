import { createRoot } from 'react-dom/client'
import './styles.css'
import { sessionState } from '@workerdeck/protocol'
import { SessionCard } from './sidebar/SessionCard.tsx'

const base = {
  engine: 'claude' as const,
  cwd: '/Users/atomic/projects/ai/workerdeck',
  createdAt: Date.now() - 240_000,
  lastActivityAt: Date.now() - 240_000,
  pendingPermissionCount: 0,
} as never

function mk(o: Record<string, unknown>) {
  return { ...(base as object), ...o } as never
}

// `agentType`, not `name`: that is what `isAgentRecord` reads, and with `name` these records all draw as tasks.
// The last one drops `agentType` on purpose, so the preview carries one real task beside the agents.
const agents = [
  { toolUseId: 'a', agentType: 'Explore', description: 'Fix base-url and re-run', status: 'done', toolCount: 4 },
  { toolUseId: 'b', agentType: 'Explore', description: 'Send measurement in debug', status: 'done', toolCount: 7 },
  { toolUseId: 'c', agentType: 'general-purpose', description: 'Build app for simulator to verify', status: 'done', toolCount: 12 },
  { toolUseId: 'd', agentType: 'general-purpose', description: 'Check build result', status: 'done', toolCount: 2 },
  { toolUseId: 'e', agentType: 'fable', description: 'Deploy release build to phone', status: 'running', toolCount: 3 },
  { toolUseId: 'f', description: 'Fix release build and redeploy', status: 'done', toolCount: 1 },
]

const ICON_HASH = 'deadbeef'
const projectIcons = {
  [ICON_HASH]:
    'data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d4d4d4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 20.5 7.75 12 12.5 3.5 7.75Z"/><path d="M3.5 12.25 12 17l8.5-4.75"/><path d="M3.5 16.5 12 21.25l8.5-4.75"/></svg>',
    ),
}
const wd = {
  name: 'WorkerDeck',
  root: '/Users/atomic/projects/ai/workerdeck',
  icon: { type: 'image', mediaType: 'image/svg+xml', hash: ICON_HASH },
}

const rows = [
  mk({
    id: '1',
    title: 'Continue session load optimization',
    status: 'running',
    model: 'claude-opus-5-20260101[1m]',
    subagents: agents,
    project: wd,
  }),
  // Same project, deep in a package — the row that used to read `ui`.
  mk({
    id: '6',
    title: 'Terminal fold audit',
    status: 'idle',
    model: 'claude-opus-5',
    cwd: '/Users/atomic/projects/ai/workerdeck/packages/ui',
    project: wd,
    lastActivityAt: Date.now() - 900_000,
  }),
  // Bytes not in yet: name, no picture, no reserved hole.
  mk({
    id: '7',
    title: 'Waiting on its icon',
    status: 'idle',
    model: 'claude-opus-5',
    project: { ...wd, icon: { type: 'image', mediaType: 'image/png', hash: 'notyet' } },
    lastActivityAt: Date.now() - 1_200_000,
  }),
  mk({
    id: '2',
    title: 'Theme design rework',
    status: 'idle',
    model: 'claude-fable-5',
    cwd: '/x/silktree',
    project: { name: 'Silktree', root: '/x/silktree', icon: { type: 'glyph', name: 'tree-pine' } },
    lastActivityAt: Date.now() - 2_700_000,
  }),
  // A well-formed glyph name this build has never heard of → the folder.
  mk({
    id: '3',
    title: 'Grid layout exploration',
    status: 'idle',
    model: 'claude-opus-5',
    cwd: '/x/zigby',
    project: { name: 'Zigby', root: '/x/zigby', icon: { type: 'glyph', name: 'some-icon-shipped-last-tuesday' } },
    lastActivityAt: Date.now() - 7_200_000,
  }),
  // No `.workerdeck.json` anywhere above it: the basename, exactly as before.
  mk({
    id: '4',
    title: 'Launch preparation',
    status: 'idle',
    model: 'claude-opus-5',
    cwd: '/x/atomic',
    lastActivityAt: Date.now() - 21_600_000,
  }),
  mk({
    id: '8',
    title: 'Codex spawn options',
    status: 'idle',
    engine: 'codex',
    model: 'gpt-5-codex',
    cwd: '/x/wd',
    project: { name: 'WorkerDeck', root: '/x/wd', icon: { type: 'glyph', name: 'layers' } },
    lastActivityAt: Date.now() - 300_000,
  }),
  mk({
    id: '5',
    title: 'Codex parity sweep',
    status: 'awaiting_approval',
    engine: 'codex',
    model: 'gpt-5-codex',
    cwd: '/x/wd',
    project: { name: 'WorkerDeck', root: '/x/wd', icon: { type: 'glyph', name: 'layers' } },
    pendingPermissionCount: 1,
  }),
]

const unseen: Record<string, number> = { '2': 12, '3': 33 }

createRoot(document.getElementById('root')!).render(
  <div className="flex flex-col text-body-sm">
    <div className="flex flex-col gap-1 p-1">
      {rows.map((r: never, i) => (
        <SessionCard
          key={i}
          row={{
            hostId: 'local',
            hostName: 'local',
            local: true,
            adapter: 'claude',
            state: sessionState(r),
            info: r,
            unseen: unseen[(r as { id: string }).id] ?? 0,
          }}
          projectIcons={projectIcons}
          selected={i === 0}
          activeSubagentId={i === 0 ? 'a' : undefined}
          onSelect={() => {}}
          onSelectSubagent={() => {}}
          onRevealStep={() => {}}
          onRename={() => {}}
          onMenu={() => {}}
        />
      ))}
    </div>
  </div>,
)
