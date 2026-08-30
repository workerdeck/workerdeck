import type { Meta, StoryObj } from '@storybook/react-vite'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { Transcript } from '../src/components/agent/Transcript.tsx'
import {
  TranscriptDensityProvider,
  TranscriptVariantProvider,
  type TranscriptDensity,
  type TranscriptVariant,
} from '../src/components/agent/transcript-variant.tsx'

/**
 * The agent transcript with all visual knobs exposed — font size, variant,
 * density, sticky prompt, scrubber, affordances. Use this story to test
 * the visual effect of each setting in isolation and in combination.
 *
 * The fixture exercises all message features: headings, code blocks, tables,
 * lists, inline code, blockquotes, bold, italic, links, and long markdown.
 */

// ── Fixture: a rich transcript with every markdown feature ──────────────

const richItems = (): TranscriptItem[] => {
  const items: TranscriptItem[] = []

  // Turn 1 — user prompt with a skill chip
  items.push({
    kind: 'user',
    id: 'u1',
    text: 'Can you give me a complete overview of the data model? Include tables, code examples, and architecture notes.',
  })

  // Turn 1 — assistant response with headings, lists, bold, inline code
  items.push({
    kind: 'assistant_text',
    id: 'a1',
    streaming: false,
    parentToolUseId: null,
    text: `# Data Model Overview

The system uses three core entities. Each is stored in its own table and linked by foreign keys.

## Entities

### User

The root entity. Every other record points back here.

- **id** — UUID v7 (time-sortable)
- **email** — unique, indexed
- **created_at** — \`timestamptz\`, defaults to \`now()\`
- **role** — one of \`admin\`, \`member\`, \`viewer\`

### Session

A conversation between the user and the agent.

1. Created by \`POST /sessions\`
2. Attached via WebSocket for streaming
3. Parked after idle timeout
4. Dormant after extended inactivity

### Event

The append-only log that records everything that happened in a session.

> Events are **immutable** once written. The transcript is a projection of the event log, not a separate store. This is the single source of truth for replays.

## Schema

| Table | PK | Notable columns | Index |
|-------|-----|------------------|-------|
| users | id (uuid) | email, role, created_at | email UNIQUE |
| sessions | id (uuid) | user_id, status, cwd, engine | user_id, status |
| events | id (bigserial) | session_id, kind, payload, seq | session_id + seq |
| snapshots | session_id | data (jsonb), written_at | session_id UNIQUE |

## Code Example

Here's how you'd query a session's full event log:

\`\`\`sql
SELECT e.seq, e.kind, e.payload
FROM events e
WHERE e.session_id = $1
ORDER BY e.seq ASC;
\`\`\`

And the TypeScript interface for an event:

\`\`\`typescript
interface SessionEvent {
  id: string
  sessionId: string
  kind: 'user_message' | 'assistant_text' | 'tool_call' | 'tool_result'
  payload: Record<string, unknown>
  seq: number
  timestamp: Date
}
\`\`\`

## Performance Notes

- The \`events\` table uses \`BRIN\` indexing on \`seq\` for range scans
- Snapshots are compressed with \`zstd\` before writing to the \`data\` column
- The \`status\` column on sessions uses a **partial index**: \`WHERE status != 'closed'\`
`,
  })

  // Turn 2 — tool call
  items.push({
    kind: 'tool_call',
    id: 'tc1',
    name: 'Read',
    parentToolUseId: null,
    input: { file_path: '/packages/server/src/lib/registry.ts' },
    status: 'settled',
    result: {
      content: `export class SessionRegistry {\n  #sessions = new Map<string, ManagedSession>()\n\n  async create(opts: CreateOptions): Promise<SessionInfo> {\n    const id = randomUUID()\n    const runner = await createRunner(opts)\n    this.#sessions.set(id, { runner, info: { id, ...opts } })\n    return this.#sessions.get(id)!.info\n  }\n}`,
    },
  } as unknown as TranscriptItem)

  // Turn 2 — response with blockquote, inline code
  items.push({
    kind: 'assistant_text',
    id: 'a2',
    streaming: false,
    parentToolUseId: null,
    text: `Looking at the registry, a few things stand out:

- \`#sessions\` is a private \`Map\`, so iteration order is insertion order
- \`create()\` is \`async\` because \`createRunner\` may need to spawn a process
- The \`id\` is a \`randomUUID()\` — not a UUID v7 like the user model

> **Note:** The registry does not persist sessions to disk by itself. The \`SnapshotStore\` is a separate seam that the dormancy timer writes through. This separation is deliberate: the registry is fast (in-memory), the store is durable (on-disk), and they compose rather than entangle.

### Migration Path

If you need to add a column to \`events\`:

\`\`\`sql
ALTER TABLE events ADD COLUMN metadata jsonb DEFAULT '{}';
\`\`\`

This is safe online because the default is not volatile and the column is nullable in effect (the default fills it).`,
  })

  // Turn 3 — another user turn
  items.push({
    kind: 'user',
    id: 'u3',
    text: 'What about the relationship between sessions and the queue? How do jobs fit in?',
  })

  // Turn 3 — response with a comparison table
  items.push({
    kind: 'assistant_text',
    id: 'a3',
    streaming: false,
    parentToolUseId: null,
    text: `## Sessions vs Jobs

They serve different purposes but share the same transcript infrastructure:

| Aspect | Session | Job |
|--------|---------|-----|
| **Lifecycle** | Interactive, user-driven | Fire-and-forget, queue-driven |
| **Operator** | Present (types prompts) | Absent (prompt provided at creation) |
| **Permissions** | Interactive approval | Pre-authorized (\`bypassPermissions\`) |
| **Parking** | Idle → parked → dormant | Runs to completion, then closed |
| **Cost tracking** | Per-turn, cumulative | Per-job, reported on completion |

### The Queue's Role

The queue is a *scheduler*, not a *runner*:

1. It accepts job requests and persists them
2. It claims one at a time (\`claimNext\` is atomic — see \`packages/queue\`)
3. It creates a session with the job's prompt and options
4. It monitors the session until it settles
5. It records the outcome and moves to the next job

\`\`\`typescript
// Simplified job loop
while (true) {
  const job = await queue.claimNext()
  if (!job) { await sleep(pollInterval); continue }

  const session = await registry.create({
    prompt: job.prompt,
    model: job.model,
    bypassPermissions: true,
  })

  await session.waitForIdle()
  await queue.complete(job.id, { cost: session.totalCostUsd })
}
\`\`\`

The key constraint: **\`claimNext\` must be atomic.** Two workers calling it simultaneously must never receive the same job. This is enforced at the adapter level (\`PostgresAdapter\` uses \`SELECT ... FOR UPDATE SKIP LOCKED\`).`,
  })

  // Turn 4 — short follow-up
  items.push({
    kind: 'user',
    id: 'u4',
    text: 'Perfect, thanks. One more — are there any known gotchas with the event log?',
  })

  items.push({
    kind: 'assistant_text',
    id: 'a4',
    streaming: false,
    parentToolUseId: null,
    text: `Yes, a few that have cost debugging time:

1. **Sequence numbers are session-scoped, not global.** Two sessions can both have \`seq: 1\`. The unique key is \`(session_id, seq)\`, not \`seq\` alone.

2. **\`tool_result\` events carry the tool's output, not the model's interpretation.** The model sees the result in its next turn's context, but the event log records what the tool *actually returned* — which can differ from what the model *says* it returned.

3. **Replay deduplication keys on \`uuid\`, not \`seq\`.** The SDK re-streams user messages on resume, and the reducer dedupes them by their uuid. If you synthesize events without unique uuids, the replay will silently drop duplicates.

4. **Sub-agent events score zero in \`transcriptActivity\`.** Any event with a \`parentToolUseId\` does not count toward the unread badge. This is intentional: a sub-agent can produce hundreds of events inside one \`Task\` row, and a badge that says "847 new" when only 3 top-level things happened is a lie.

---

*These are all documented in \`docs/GOTCHAS.md\` — the canonical list of invariants that bite.*`,
  })

  return items
}

const state: TranscriptState = {
  status: 'idle',
  capabilities: ENGINE_CAPABILITIES.claude,
  items: richItems(),
  pendingApprovals: [],
  totalCostUsd: 0.127,
  lastSeq: 40,
}

// ── Story ────────────────────────────────────────────────────────────────

/**
 * Wraps the Transcript with the variant/density context providers and
 * applies `--wd-font-size` on the container (the same mechanism
 * SessionPanel uses).
 */
function AgentViewShell({
  variant = 'cards',
  density = 'comfortable',
  fontSize,
  children,
}: {
  variant?: TranscriptVariant
  density?: TranscriptDensity
  fontSize?: number
  children: React.ReactNode
}) {
  return (
    <TranscriptVariantProvider value={variant}>
      <TranscriptDensityProvider value={density}>
        <div
          data-slot="session-panel"
          data-theme="dark"
          style={
            {
              height: '100vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--bg)',
              ...(fontSize ? { '--wd-font-size': `${fontSize}px` } : {}),
            } as React.CSSProperties
          }
        >
          {children}
        </div>
      </TranscriptDensityProvider>
    </TranscriptVariantProvider>
  )
}

const meta: Meta<typeof Transcript> = {
  title: 'Agent/AgentView',
  component: Transcript,
  parameters: {
    layout: 'fullscreen',
  },
  argTypes: {
    variant: {
      control: 'select',
      options: ['cards', 'terminal'],
      description: 'Transcript variant — chat bubbles or terminal lines',
    },
    density: {
      control: 'select',
      options: ['comfortable', 'compact'],
      description: 'Row spacing (cards only)',
    },
    fontSize: {
      control: { type: 'range', min: 10, max: 20, step: 1 },
      description: 'Base font size in px — drives everything',
    },
    stickyPrompt: {
      control: 'boolean',
      description: 'Pin the last prompt to the top while scrolling',
    },
    scrubber: {
      control: 'boolean',
      description: 'Show the overview ruler (terminal only)',
    },
    affordances: {
      control: 'boolean',
      description: 'Hover fill and copy actions (terminal only)',
    },
  },
}
export default meta

type AgentViewArgs = {
  variant: TranscriptVariant
  density: TranscriptDensity
  fontSize: number | undefined
  stickyPrompt: boolean
  scrubber: boolean
  affordances: boolean
}

type Story = StoryObj<AgentViewArgs>

const Template = (args: AgentViewArgs) => (
  <AgentViewShell variant={args.variant} density={args.density} fontSize={args.fontSize}>
    <Transcript
      state={state}
      variant={args.variant}
      density={args.density}
      stickyPrompt={args.stickyPrompt}
      scrubber={args.scrubber}
      affordances={args.affordances}
      fontSize={args.fontSize}
    />
  </AgentViewShell>
)

/** Cards at 13px (default) — the baseline. */
export const Default: Story = {
  render: Template,
  args: {
    variant: 'cards',
    density: 'comfortable',
    fontSize: undefined,
    stickyPrompt: false,
    scrubber: false,
    affordances: true,
  },
}

/** Cards at 11px — the compact reading the user asked for. */
export const Small: Story = {
  render: Template,
  args: {
    variant: 'cards',
    density: 'comfortable',
    fontSize: 11,
    stickyPrompt: false,
    scrubber: false,
    affordances: true,
  },
}

/** Cards at 16px — large, for high-DPI or accessibility. */
export const Large: Story = {
  render: Template,
  args: {
    variant: 'cards',
    density: 'comfortable',
    fontSize: 16,
    stickyPrompt: false,
    scrubber: false,
    affordances: true,
  },
}

/** Terminal at 11px with scrubber and sticky prompt. */
export const TerminalSmall: Story = {
  render: Template,
  args: {
    variant: 'terminal',
    density: 'comfortable',
    fontSize: 11,
    stickyPrompt: true,
    scrubber: true,
    affordances: true,
  },
}

/** Terminal at default size. */
export const TerminalDefault: Story = {
  render: Template,
  args: {
    variant: 'terminal',
    density: 'comfortable',
    fontSize: undefined,
    stickyPrompt: true,
    scrubber: true,
    affordances: true,
  },
}
