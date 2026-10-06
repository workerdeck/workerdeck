---
title: Agents and teams
description: Long-lived, named agents with an avatar and a standing brief, grouped into one-level teams.
order: 13
---

A **session** is one run. An **agent** is the identity that outlives it: a name, an avatar, a
standing brief and the config its sessions start from, kept by the gateway in
`<state-dir>/agents.json`. An agent owns one session at a time. Clearing, compaction, sleep and a
gateway restart all keep that session; *New conversation* starts a fresh one under the same
identity and team.

## Create one

- **VS Code:** the person icon in the Sessions title (*New Agent*), or *Make agent* in a card's
  `⋯` menu to keep an existing session as an agent.
- **Dashboard:** the `+` split button opens the New agent dialog (name, project, model, brief, an
  optional first prompt). Leave the name blank and the gateway picks one.
- **REST:** `POST /v1/agents` with `{ name, brief, config: { cwd, model, ... }, prompt }`, or
  `{ adopt: "<session id>" }`. The `/agents` routes are operator-only.

The brief reaches the model as host instructions on every session the agent runs; it is not part
of the session data clients receive.

## Teams

A team is a lead and the agents that name it as their lead, **one level deep**: a lead cannot join
another team, and nobody can join a member. Drag a card onto another agent to join its team, drop
it between members to place it, and drag a member out to leave; the card menus offer the same
moves. In the list, members sit under their lead on a tree line, and a folded team shows each
member's avatar and status on the lead's own line.

Teams also scope peer messaging: a member reaches only its lead and teammates, nobody outside the
team reaches a member, and members never cross a [relay](/workerdeck/docs/guides/cross-gateway-peers/). In the
composer, `#` finds an agent by its name.

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
