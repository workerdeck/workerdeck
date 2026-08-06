# Manual smokes

Things `pnpm test` deliberately cannot check. Run these by hand.

| Script | Command | Costs money? |
| --- | --- | --- |
| Sandbox boundary | `pnpm smoke:sandbox` | No |
| Live model loop | `<KEY>=... pnpm smoke:live [provider] [model]` | **Yes — real tokens** |
| Full SDK-client stack | `<KEY>=... pnpm smoke:sdk [provider] [model]` | **Yes — real tokens** |
| Live MCP | `pnpm smoke:mcp --probe` / `<KEY>=... pnpm smoke:mcp [provider] [model]` | Probe: no. Full: **yes** |
| Message attachments | `pnpm smoke:media [image\|pdf\|text]` | **Yes — real tokens** |
| Codex engine | `pnpm smoke:codex --canary` / `pnpm smoke:codex [model]` | Canary: no. Full: **yes — plan/API usage** |

## `smoke:sandbox` — the untrusted-code boundary

Eight scenarios covering the happy path, two escape attempts, two denial-of-service attempts,
the network gate, and cross-run isolation. Each prints what it proves, so a green run reads as
evidence rather than a wall of PASS lines. Exits non-zero if any scenario fails.

Run your own script inside the sandbox (the VFS is seeded with `/docs/example.txt`):

```bash
pnpm smoke:sandbox 'vfs.read("/docs/example.txt")'
pnpm smoke:sandbox 'while (true) {}'            # watch the deadline fire
pnpm smoke:sandbox 'require("fs")'              # watch it fail
```

## `smoke:live` — the model-agnostic loop against a real provider

The unit tests drive a fake model, so they cannot validate real tool-call payload shapes or
provider event drift. This closes that gap: the model is asked a question it can only answer by
running code over a file in the sandbox VFS, exercising **park → sandbox execute → message-state
replay → completion**.

```bash
MOONSHOT_API_KEY=...  pnpm smoke:live              # Kimi K3 (default)
OPENAI_API_KEY=...    pnpm smoke:live openai
ANTHROPIC_API_KEY=... pnpm smoke:live anthropic
ANTHROPIC_API_KEY=... pnpm smoke:live anthropic claude-opus-5
```

The document says `revenue: 4173`, `employees: 12`, so the only correct answer is **348** — a
model that guesses instead of running code gets it wrong visibly. The script exits non-zero if
the turn never completes, or if the model answered without calling the tool at all (which would
mean the loop was never exercised).

Run it against two providers to satisfy the PRD's SM-1 (same workflow, config swap only).

## `smoke:sdk` — the whole stack, the way a consumer runs it

`smoke:live` drives the runner in-process; `bridge-e2e.test.ts` drives the real server and
client with a stubbed model. This smoke is the combination neither covers:

    real model → AiSdkRunner on createWorkerServer → HTTP/WS → WorkerDeckClient
    → createToolCallHost executing in a real QuickJS guest

The server has **no QuickJS executor at all** here — every `eval_script` call must travel the
bridge to the client's sandbox (the run fails if none does), while the authoritative `fs_*`
tools run server-side, proving the trust split live. Bridged results re-enter the loop through
the server's own wiring (`BridgeHub.onResult` → `runner.settleExecution`).

```bash
MOONSHOT_API_KEY=...  pnpm smoke:sdk              # Kimi K3 (default)
OPENAI_API_KEY=...    pnpm smoke:sdk openai
ANTHROPIC_API_KEY=... pnpm smoke:sdk anthropic
```

Hard failures: turn doesn't complete or errors, no bridged client execution, an execution on a
non-browser backend, wrong answer (348), or empty turn usage. The server-side
`/out/report.json` written by `fs_write` is reported but only warned on — providers vary in
following that instruction. Verified against `claude-sonnet-5` and `gpt-5`.

## `smoke:mcp` — live MCP tools from a real remote server

The unit tests drive `connectMcpTools` against a stub; this connects to **DeepWiki**
(`https://mcp.deepwiki.com/mcp`, free, no auth) for real: streamable-http transport, tools
namespaced `deepwiki__*`, granted to a provider session as authoritative (server-side execute,
never bridged), with a prompt only answerable through them.

```bash
pnpm smoke:mcp --probe                    # connect + list tools + clean close — FREE
ANTHROPIC_API_KEY=... pnpm smoke:mcp anthropic   # full loop — costs tokens
```

Hard failures: no tools (server unreachable or protocol drift), tools not namespaced, turn
doesn't complete, or the model answered without a single `deepwiki__*` call. Verified against
`claude-sonnet-5`.

## `smoke:media` — attachments the model can actually see

The only thing that can validate the attachment wire. `pnpm test` proves the server turns an
uploaded file into the right content blocks; it cannot prove the **CLI accepts them on streamed
input**, and a CLI that dropped non-text blocks would look exactly like a model ignoring the
picture. So this drives the shipped path end to end — generated file → `POST
/sessions/:id/attachments` → `user_message(attachmentIds)` → real Claude Code — and asks a
question whose answer exists only inside the attachment.

```bash
pnpm smoke:media              # image, pdf and text
pnpm smoke:media image        # one kind
```

The three fixtures are generated, not committed: a PNG built chunk by chunk (so the repo carries
no binaries) and a one-page PDF with computed xref offsets — a hand-guessed xref is the usual
reason a minimal PDF is rejected. Hard failures: an answer that doesn't name the colour, the two
words on the PDF page, or the passphrase in the text file. Verified against `claude-opus-5`.

## `smoke:codex` — the Codex engine against the real binary

The codex unit tests drive a scripted JSON-RPC peer, so they cannot validate the real
`codex app-server` v2 vocabulary (pre-1.0, regenerable per release — drift is promised), the
spawn contract, the handshake, or the auth chain. This is the drift alarm: **any change to
`CodexRunner`'s spawn options, handshake, or event mapping requires a run** — it is to Codex
what the permission smoke is to Claude.

```bash
pnpm smoke:codex --canary       # FREE (network only): the auth-drift canaries
pnpm smoke:codex                # full run — needs codex auth, costs plan/API usage
pnpm smoke:codex gpt-5.6-sol    # full run on a specific model (default gpt-5.6-luna)
```

The free canaries pin the verified auth matrix with fake keys against a scratch `CODEX_HOME`,
running real turns through `CodexRunner` + `connectAppServer` — so a free run also exercises
the spawn, the `initialize` handshake, and `thread/start`. The pinned facts (2026-08-05,
0.146.0): `OPENAI_API_KEY` is ignored ("Missing bearer" — no credential sent), `CODEX_API_KEY`
is **exec-only and equally ignored by the app-server** (the day either flips to
`invalid_api_key`, the availability probe's rules are stale — see GOTCHAS §Codex), and
`codex login status` still exit-codes its verdict. They also pin the two approval gates
(`capabilities.experimentalApi` at initialize, the granular `approvalPolicy` at `thread/start`)
and the shape of `skills/list` — free because it is a local directory scan, and worth pinning
because `engines/codex/types.ts` mirrors it by hand. The skills check asserts *structure* only,
never which skills this machine happens to have.

The paid part needs the one supported auth route — `codex login` (or
`codex login --with-api-key`) **run in your own terminal** — and covers: token deltas actually
arriving and agreeing with the final message (the reason this transport exists), a real command
execution mapped to `CodexCommand` with its output and exit code, the usage-relation asserts on
a cache-heavy resume turn (usage is summed from `thread/tokenUsage/updated`), resume continuity
across child processes, interrupt landing cleanly *and* the thread staying resumable after,
`default` mode's read-only sandbox actually refusing a write, and a `localImage` attachment
answered correctly.
