# Manual smokes

Things `pnpm test` deliberately cannot check. Run these by hand.

| Script | Command | Costs money? |
| --- | --- | --- |
| Sandbox boundary | `pnpm smoke:sandbox` | No |
| Live model loop | `<KEY>=... pnpm smoke:live [provider] [model]` | **Yes — real tokens** |
| Full SDK-client stack | `<KEY>=... pnpm smoke:sdk [provider] [model]` | **Yes — real tokens** |
| Live MCP | `pnpm smoke:mcp --probe` / `<KEY>=... pnpm smoke:mcp [provider] [model]` | Probe: no. Full: **yes** |

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
