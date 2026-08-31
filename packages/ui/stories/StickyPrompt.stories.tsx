import type { Meta, StoryObj } from '@storybook/react-vite'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'
import type { TranscriptItem, TranscriptState } from '@workerdeck/react'
import { Transcript } from '../src/components/agent/Transcript.tsx'
import { TranscriptDensityProvider, TranscriptVariantProvider } from '../src/components/agent/transcript-variant.tsx'

const mockItems = (): TranscriptItem[] => {
  const items: TranscriptItem[] = []
  items.push({
    kind: 'user',
    id: 'u1',
    text: 'Can you explain how the session lifecycle works? I want to understand parking, dormancy, and how a session survives a server restart.',
  })
  items.push({
    kind: 'assistant_text',
    id: 'a1',
    text: "The session lifecycle has three main states:\n\n**Running** — the session has an active engine process behind it. Messages flow through the WebSocket, tools execute, and the transcript grows.\n\n**Parked** — the engine process is torn down but the session's state is preserved in a `RunnerSnapshot`. This happens automatically after idle timeout or explicitly via the park command. The snapshot captures the full event log, the conversation history, and any in-flight state.\n\n**Dormant** — a parked session whose snapshot has been written to disk and evicted from memory. The gateway keeps only the `SessionInfo` metadata. Waking a dormant session reads the snapshot back, restores the engine, and replays the conversation.\n\nThe key insight is that parking is *not* saving — it's closer to hibernation. The snapshot is the session's RAM image, and restoring from it is faster than replaying the conversation from scratch because the engine can skip the model's own state reconstruction.",
    streaming: false,
    parentToolUseId: null,
  })
  items.push({
    kind: 'tool_call',
    id: 'tc1',
    name: 'Read',
    parentToolUseId: null,
    input: { file_path: '/packages/core/src/runner-interface.ts' },
    status: 'settled',
    result: {
      content:
        '// Runner interface\nexport interface Runner {\n  park(): Promise<RunnerSnapshot>\n  restore(snapshot: RunnerSnapshot): Promise<void>\n  snapshot(): RunnerSnapshot\n}',
    },
  } as unknown as TranscriptItem)
  items.push({
    kind: 'assistant_text',
    id: 'a1b',
    text: "Looking at the code, `park()` tears down the process and returns the snapshot, while `snapshot()` captures the same state without the teardown — it's what lets a provider session survive a restart without losing its conversation.\n\nThe restore branch in `start()` schedules **nothing**, and that's load-bearing: an interrupted turn leaves the history ending on the user message, so a scheduled turn would re-run the very turn the user killed.",
    streaming: false,
    parentToolUseId: null,
  })

  items.push({
    kind: 'user',
    id: 'u2',
    text: 'What about the difference between the Claude engine and the provider engine for parking? Are there different constraints?',
  })
  items.push({
    kind: 'assistant_text',
    id: 'a2',
    text: "Yes, and the difference is fundamental:\n\n**Claude engine** — the SDK maintains its own server-side session state. `park()` snapshots the local event log and conversation, but the SDK session itself persists on Anthropic's servers. Resume is a `query({ resume: sdkSessionId })` that picks up where it left off. The snapshot's job is remembering *which* SDK session to resume and what the transcript looked like.\n\n**Provider engine** — there is no external session state. The entire conversation lives in the runner's in-memory message array. `park()` must capture *everything*, because `restore()` is building the world from scratch. This is why `snapshot()` exists separately from `park()` — a provider session that restarts without parking can recover from a snapshot taken at the last quiet moment.\n\nThe practical consequence: a Claude session can park and wake cheaply (the model doesn't re-read the conversation), while a provider session's restore cost scales with conversation length.",
    streaming: false,
    parentToolUseId: null,
  })
  items.push({
    kind: 'tool_call',
    id: 'tc2',
    name: 'Read',
    parentToolUseId: null,
    input: { file_path: '/packages/core/src/engines/provider/session.ts' },
    status: 'settled',
    result: {
      content:
        '// Provider session\nexport class AiSdkSession {\n  #messages: CoreMessage[] = []\n  #vfs: Map<string, string>\n  \n  async park(): Promise<RunnerSnapshot> {\n    return { messages: this.#messages, vfs: this.#vfs, log: this.#log }\n  }\n}',
    },
  } as unknown as TranscriptItem)
  items.push({
    kind: 'assistant_text',
    id: 'a2b',
    text: 'One more thing worth noting: `seedVfs` is ignored on a restore for exactly this reason. A seed overwrites the virtual filesystem with starter content, which is right for a new session and destructive for a parked one — it would erase whatever files the agent had been working with.\n\nThe `id` option on restore is what lets a session come back as *itself* — without it, the registry would assign a new id and every client holding the old one would see a 404.',
    streaming: false,
    parentToolUseId: null,
  })

  items.push({ kind: 'user', id: 'u3', text: 'How does the gateway decide when to park a session? And what triggers dormancy?' })
  items.push({
    kind: 'assistant_text',
    id: 'a3',
    text: "Two timers, configured on the server:\n\n**Park timeout** (`parkAfterIdleMs`, default 5 minutes) — fires when the session has been idle (no turn in flight, no pending approval) for this long. The registry calls `runner.park()`, captures the snapshot, and holds it in memory. The session stays on the sessions list and can wake instantly.\n\n**Dormancy timeout** (`dormantAfterMs`, default 30 minutes after parking) — fires when a parked session has had no attach for this long. The snapshot is written to disk (the `SnapshotStore` seam — file-backed by default, pluggable for S3/etc.), evicted from memory, and the session record is trimmed to just its `SessionInfo`. Waking a dormant session reads the snapshot back from disk.\n\nThe distinction matters because parking is cheap (milliseconds, stays in RAM) while dormancy trades latency for memory. A server with 200 parked sessions is fine; 200 snapshots in memory is not.\n\nThere's a subtlety with attachments: a client attached to a session resets the dormancy timer but not the park timer. A watched session stays in RAM because someone is looking at it, but it still parks its engine because nobody is *driving* it.",
    streaming: false,
    parentToolUseId: null,
  })

  items.push({
    kind: 'user',
    id: 'u4',
    text: 'Last question — what happens if the server crashes while a session is running? Is there any recovery path?',
  })
  items.push({
    kind: 'assistant_text',
    id: 'a4',
    text: "Partial recovery, with an honest gap:\n\n**If `snapshot()` was called** (the periodic checkpoint, every N events) — the last snapshot is on disk, and the session can be restored from it. Everything since the last checkpoint is lost: events, tool results, streamed text. The transcript will have a visible gap, and the model's conversation will be missing its most recent context.\n\n**If no snapshot exists** — the session is gone. The event log might exist on disk (if the runner was configured to persist it), but there's no conversation state to restore from, and replaying events through a fresh engine is not the same as resuming one.\n\nThis is why `snapshot()` exists as a separate operation from `park()`: it lets you checkpoint without tearing down the engine. The trade-off is that every checkpoint writes the full log to disk, so the interval is a balance between recovery granularity and I/O cost.\n\nThe honest answer is that crash recovery is best-effort. The real protection is parking: a parked session's snapshot is complete and consistent, and the only thing that can lose it is disk failure. That's why the idle-park timeout defaults to 5 minutes rather than an hour — the window of vulnerability is the time between the last turn and the park.",
    streaming: false,
    parentToolUseId: null,
  })

  return items
}

const state: TranscriptState = {
  status: 'idle',
  capabilities: ENGINE_CAPABILITIES.claude,
  items: mockItems(),
  pendingApprovals: [],
  totalCostUsd: 0.0342,
  lastSeq: 20,
}

const meta: Meta<typeof Transcript> = {
  title: 'Agent/StickyPrompt',
  component: Transcript,
  parameters: {
    layout: 'fullscreen',
  },
}

export default meta
type Story = StoryObj<typeof Transcript>

export const Cards: Story = {
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="cards">
        <TranscriptDensityProvider value="comfortable">
          <div style={{ height: '300px', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }} data-theme="dark">
            <Story />
          </div>
        </TranscriptDensityProvider>
      </TranscriptVariantProvider>
    ),
  ],
  args: {
    state,
    variant: 'cards',
    density: 'comfortable',
    stickyPrompt: true,
  },
}

export const CardsCompact: Story = {
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="cards">
        <TranscriptDensityProvider value="compact">
          <div style={{ height: '300px', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }} data-theme="dark">
            <Story />
          </div>
        </TranscriptDensityProvider>
      </TranscriptVariantProvider>
    ),
  ],
  args: {
    state,
    variant: 'cards',
    density: 'compact',
    stickyPrompt: true,
  },
}

export const Terminal: Story = {
  decorators: [
    (Story) => (
      <TranscriptVariantProvider value="terminal">
        <TranscriptDensityProvider value="comfortable">
          <div style={{ height: '300px', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }} data-theme="dark">
            <Story />
          </div>
        </TranscriptDensityProvider>
      </TranscriptVariantProvider>
    ),
  ],
  args: {
    state,
    variant: 'terminal',
    stickyPrompt: true,
  },
}
