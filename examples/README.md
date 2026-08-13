# Try it in the browser

Manual walkthrough for the model-agnostic engine in the real dashboard: a provider model runs
on the server, and its `eval_script` tool calls execute **in your browser tab's** QuickJS
sandbox over the WS bridge. The Claude engine stays available side by side under the `claude`
profile.

## 1. Provide a key

Put at least one provider key in the repo's `.env` (gitignored) or your shell:

```
ANTHROPIC_API_KEY=...   # → profile 'anthropic' (claude-sonnet-5)
OPENAI_API_KEY=...      # → profile 'openai'    (gpt-5)
MOONSHOT_API_KEY=...    # → profile 'moonshot'  (kimi-k3)
```

## 2. Start the worker

```bash
pnpm example:server
```

This replaces `pnpm dev:server` (same port 8787, gateway only — pair it with `pnpm dev:web` for a
dashboard). It logs the profiles it built — you want at
least one `(provider: ...)` line. Keys never leave the server; the profile only carries the
env var *name*.

## 3. Start the web app

```bash
pnpm dev:web
```

Open http://localhost:5191 (vite proxies `/v1` REST + WS to the worker).

## 4. Create a provider session

On **Sessions**:

- **Working directory:** anything, e.g. `/tmp` (provider sessions don't touch the host
  filesystem — tools operate on an in-memory scratch VFS).
- **Profile:** pick `anthropic` / `openai` / `moonshot`.
- **Permission mode:** leave *Default* — with a provider profile picked, the form only offers the
  three modes this engine runs (the CLI-only `acceptEdits` / `plan` / `auto` are gone, as is the
  "Resume a previous session" section). **Model:** leave *Profile default*. Under `anthropic` the
  picker also lists the models that profile declares in `provider.models`.
- Leave the initial prompt empty (send from the panel instead), then **Create**.

## 5. Watch the bridge work

In the session panel, send:

> Read /leads/acme.txt and tell me the revenue per employee, rounded to the nearest whole
> number. Then save {"revenuePerEmployee": <the number>} to /out/report.json using fs_write.

What you should see:

- An `eval_script` tool call with the script the model wrote.
- Its execution state going *pending → settled* — that round-trip went server → **your tab**
  (the panel hosts bridged calls on its own WS handle) → server → model. The server has no
  sandbox executor in this example; if the tab weren't attached, the call would fail with
  `no_client`.
- DevTools → Network → WS: `tool_call_request` in, `tool_call_result` out. The ~2 MB QuickJS
  guest loads lazily on the first call.
- The only correct answer is **348** (4173 / 12) — a model that guessed instead of running
  code gets it wrong visibly.
- `fs_write` runs **server-side** (authoritative tool, never bridged) — the report lands on the
  server's VFS, not the tab's.

Also worth trying:

- "Run `while(true){}` with eval_script" — the guest deadline (15 s) fails the call and the
  model adapts; the session survives.
- Ask it to `vfs.list('/')` — the scratch VFS is all it can see; no host filesystem, no network.
- Close the tab mid-execution and re-attach — late results are ignored idempotently.

## 5b. Deliverables, web pages, and MCP

Provider sessions in this example also get `web_fetch`, `deliver_file`, and (when DeepWiki is
reachable at startup — set `NO_MCP=1` to skip) the `deepwiki__*` MCP tools. Try:

> Now create SUMMARY.md summarizing what you did and deliver it to me.

The `deliver_file` call renders a **download card** in the transcript — the file is served by
`GET /v1/sessions/:id/files/<path>` from the session's in-memory VFS (it lives as long as the
session does).

> What does https://example.com say it is for?

`web_fetch` runs server-side: SSRF-guarded fetch, HTML→markdown, then a digest pass by the
session's own model (those tokens are billed into the turn's usage).

> What does the wiki for facebook/react say about hooks?

The `deepwiki__ask_question` call is a live remote MCP tool — authoritative, executed
server-side, never bridged to the tab.

## 6. Compare with the Claude engine

On **Profiles** you can also create one yourself: this dev server wires a file-backed profile
store at `.workerdeck/profiles.json` and marks every caller as able to manage profiles, so the
New profile card is live. The three profiles above are declared in `provider-server.ts` and stay
read-only — only the ones you create here can be edited or deleted.

Create a second session under the `claude` profile with a real project directory — the full
Agent SDK UI (permission prompts, model picker, slash commands) works as before. The two
engines run side by side on one server, selected per session by profile.
