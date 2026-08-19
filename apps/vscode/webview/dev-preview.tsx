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
import { SessionCard } from './sidebar/SessionCard.tsx'

const base = {
  engine: 'claude' as const,
  cwd: '/Users/atomic/projects/ai/workerdeck',
  createdAt: Date.now() - 240_000,
  lastActivityAt: Date.now() - 240_000,
  pendingPermissionCount: 0,
} as never

const mk = (o: Record<string, unknown>) => ({ ...(base as object), ...o }) as never

const agents = [
  { toolUseId: 'a', name: 'Explore', description: 'Fix base-url and re-run', status: 'done', toolCount: 4 },
  { toolUseId: 'b', name: 'Explore', description: 'Send measurement in debug', status: 'done', toolCount: 7 },
  { toolUseId: 'c', name: 'general-purpose', description: 'Build app for simulator to verify', status: 'done', toolCount: 12 },
  { toolUseId: 'd', name: 'general-purpose', description: 'Check build result', status: 'done', toolCount: 2 },
  { toolUseId: 'e', name: 'fable', description: 'Deploy release build to phone', status: 'running', toolCount: 3 },
  { toolUseId: 'f', name: 'Explore', description: 'Fix release build and redeploy', status: 'failed', toolCount: 1 },
]

const rows = [
  mk({ id: '1', title: 'Continue session load optimization', status: 'running', model: 'claude-opus-5-20260101[1m]', subagents: agents }),
  mk({ id: '2', title: 'Theme design rework', status: 'idle', model: 'claude-fable-5', cwd: '/x/silktree', lastActivityAt: Date.now() - 2_700_000 }),
  mk({ id: '3', title: 'Grid layout exploration', status: 'idle', model: 'claude-opus-5', cwd: '/x/zigby', lastActivityAt: Date.now() - 7_200_000 }),
  mk({ id: '4', title: 'Launch preparation', status: 'idle', model: 'claude-opus-5', cwd: '/x/atomic', lastActivityAt: Date.now() - 21_600_000 }),
  mk({ id: '5', title: 'Codex parity sweep', status: 'awaiting_approval', engine: 'codex', model: 'gpt-5-codex', cwd: '/x/wd', pendingPermissionCount: 1 }),
]

const unseen: Record<string, number> = { '2': 12, '3': 33 }

createRoot(document.getElementById('root')!).render(
  <div className='flex flex-col text-body-sm'>
    <div className='flex flex-col gap-1 p-1'>
      {rows.map((r: never, i) => (
        <SessionCard
          key={i}
          info={r}
          unseen={unseen[(r as { id: string }).id] ?? 0}
          selected={i === 0}
          onSelect={() => {}}
          onSelectSubagent={() => {}}
          onRename={() => {}}
          onMenu={() => {}}
        />
      ))}
    </div>
  </div>,
)
