/**
 * `pnpm --filter workerdeck-vscode dev:preview` — the Sessions sidebar's cards,
 * in a browser, against canned data.
 *
 * The webview has no dev server (`vite.config.ts` explains why: webview assets
 * must be real files under `localResourceRoots`), so the only way to look at a
 * card is normally to build the extension, launch a second VS Code, connect a
 * gateway and find a session in the state you wanted. Every state that matters
 * here — six sub-agents with one running and one failed, an unread badge, a
 * session waiting on a human, a non-Claude engine — is either rare or expensive
 * to produce on demand.
 *
 * `dev/preview.html` supplies the `--vscode-*` variables VS Code injects, at
 * their Dark+ values. That is the whole fidelity risk of this harness and it is
 * worth naming: a token this file forgets falls back to a `theme.css` default
 * and looks *fine here* while being wrong in the editor. It is a place to check
 * layout and hierarchy, not a substitute for looking at the real thing once.
 *
 * Dev-only, and unpackaged: `.vscodeignore` allows `dist/` and nothing else.
 */
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

const mk = (o: Record<string, unknown>) => ({ ...(base as object), ...o }) as never

/**
 * `agentType`, not `name` — that is what `isAgentRecord` reads, and the two are
 * not interchangeable. With `name` these records were all **tasks**: muted, no
 * arrow, unselectable, which is the opposite of what this fixture is for. The
 * last one keeps no `agentType` on purpose, so the preview carries one real task
 * beside the agents and the difference is visible rather than asserted.
 */
const agents = [
  { toolUseId: 'a', agentType: 'Explore', description: 'Fix base-url and re-run', status: 'done', toolCount: 4 },
  { toolUseId: 'b', agentType: 'Explore', description: 'Send measurement in debug', status: 'done', toolCount: 7 },
  { toolUseId: 'c', agentType: 'general-purpose', description: 'Build app for simulator to verify', status: 'done', toolCount: 12 },
  { toolUseId: 'd', agentType: 'general-purpose', description: 'Check build result', status: 'done', toolCount: 2 },
  { toolUseId: 'e', agentType: 'fable', description: 'Deploy release build to phone', status: 'running', toolCount: 3 },
  { toolUseId: 'f', description: 'Fix release build and redeploy', status: 'done', toolCount: 1 },
]

/**
 * Projects, in all four shapes a row can be in: an image icon (the bytes
 * arrived), an image icon whose bytes have NOT arrived — the state every card
 * is in for the first beat after a poll — a glyph, a glyph name this build does
 * not know (which must draw the folder fallback, not a hole), and no project at
 * all, which must still read exactly as it did before the feature existed.
 */
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
          /* The secondary selection: card grey, that agent's row blue. It is the
             state with two claims on screen at once, so it is the one worth
             having a fixture for. */
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
