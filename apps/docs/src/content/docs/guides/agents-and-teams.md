---
title: Agents and teams
description: Long-lived, named agents with an avatar and a standing brief, grouped into one-level teams.
order: 13
---

A **session** is one run. An **agent** is the identity that outlives it: a name, an avatar, a
standing brief and the config its sessions start from, kept by the gateway in
`<state-dir>/agents.json`. An agent owns one session at a time, its current **conversation**.
Compaction, sleep and a gateway restart all keep it; *New conversation* starts a fresh one under the
same identity and team (see [Conversations](#conversations)).

## Create one

- **VS Code:** the person icon in the Sessions title (*New Agent*), or *Make agent* in a card's
  `⋯` menu to keep an existing session as an agent.
- **Dashboard:** the `+` split button opens the New agent dialog (name, project, model, brief, an
  optional first prompt). Leave the name blank and the gateway picks one.
- **Change one later:** in VS Code, *Edit settings* and *Edit brief* in the card's `⋯` menu open
  the agent's settings as JSON (with completion) and its brief as markdown; saving applies them.
  Over REST, `PATCH /v1/agents/:id` with `{ "config": { ... } }` merges keys, and `null` clears one.
- **REST:** `POST /v1/agents` with `{ name, brief, config: { cwd, model, ... }, prompt }`, or
  `{ adopt: "<session id>" }`. The `/agents` routes are operator-only.

The brief reaches the model as host instructions on every session the agent runs; it is not part
of the session data clients receive.

## Conversations

*New conversation* in an agent's card menu (idle agents only) starts a clean conversation: same
card, same place in the list, an empty transcript. Previous chat context is not carried over. An
agent can do the same itself with the `context_reset` tool, which runs once its turn ends. A typed
`/clear` still clears within the current conversation; agent cards offer no *Clear context*.

The old conversation is archived: it leaves the list and stays readable, read-only, under
*Conversations* on the agent (card menu on the dashboard and in VS Code, a long-press on the
phones). Its history comes from the engine's own session store, so it follows that engine's
retention: a transcript Claude Code or Codex has since pruned shows as unavailable. A view that
shows an agent follows it into each new conversation and keeps an unsent draft as a draft.

*Delete agent...* removes the agent from your agents and releases its team members. Its
conversations stay readable under *Past agents*. Over REST: `POST /v1/agents/:id/restart` (New
conversation), `GET /v1/agents/:id/conversations`, `GET /v1/agents?retired=1`, `DELETE
/v1/agents/:id`; each change names the conversation it acts on with `expectedSessionId`.

## Teams

A team is a lead and the agents that name it as their lead, **one level deep**: a lead cannot join
another team, and nobody can join a member. Drag a card onto another agent to join its team, drop
it between members to place it, and drag a member out to leave; the card menus offer the same
moves. In the list, members sit under their lead on a tree line, and a folded team shows each
member's avatar and status on the lead's own line.

Teams also scope peer messaging: a member reaches only its lead and teammates, and nobody outside
the team reaches a member. With a [relay](/workerdeck/docs/guides/cross-gateway-peers/) a team can
span gateways, and agents of different owners meet only in a team or as two shared agents (see
[Owners](/workerdeck/docs/guides/cross-gateway-peers/#owners-sharing-a-relay-with-colleagues)).
In the composer, `#` finds an agent by its name.

### One repository, one persona per folder

Claude Code and Codex both read instruction files from the session's folder **and every folder
above it**, so a member working in `packages/db` also loads the root `AGENTS.md`, often the lead's
persona. Set `config.instructionScope: "cwd"` on a member (or *Loads instruction files from its
project folder only* in New agent, or `PATCH /v1/agents/:id` with `{ "config": { "instructionScope": "cwd" } }`)
and its sessions load only the files in its own folder and below: no `AGENTS.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md` or `.claude/rules/` from the folders
above. Your own `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` still load. The default,
`"ancestors"`, is the engines' own behaviour. A recommended layout: the lead persona in the root
`AGENTS.md`, one persona per member folder, and anything every member needs in each member's
file or brief. The change applies from the agent's next session start or wake. Claude Code does
not follow an `@`-import that points outside the session's folder (for example
`@../../docs/CONVENTIONS.md`) unless you approve it, with or without this setting, and Codex
does not follow imports at all, so keep shared text inside each member's folder.

## Private and shared

An agent is Private unless you choose Shared in *New agent* or its `⋯` menu. Sharing only matters
toward other owners: a shared agent is listed for their shared agents, which can message it but
never peek at it. Sharing is set on the lead; members are never shared on their own.

## Status

Every session, agent or not, has a one-line status shown under its name: the model, then the
status. The agent sets it with the `set_status` tool (`text`, an optional `emoji`; an empty text
clears it), and you can set or clear it from the card menu or with
`PATCH /v1/sessions/:id` `{ "statusLabel": { "text": "..." } }`. It stays until changed and clears
when the conversation resets. Tell agents in your `AGENTS.md` when to use it, for example "set
your status when you start waiting on something, clear it when you're done".

## Sleep

An idle agent's engine sleeps after 15 minutes by default, freeing its memory; the next message
wakes it with its history. Set the gateway default with `--agent-sleep-after 30m` (`never` or `0`
turns it off), the VS Code setting `workerdeck.host.agentSleepAfterMinutes`, or per agent
(`config.sleepAfterMs`).

## Avatars

The `workerdeck` CLI draws avatars with monkeyart (art under CC BY 4.0). *Change avatar* in a card's
menu shows a few candidates to pick from, and an agent can give itself a new one with the
`change_avatar` tool. A gateway embedded without an avatar provider sends no `avatar`, and every
client draws an engine tile instead.
