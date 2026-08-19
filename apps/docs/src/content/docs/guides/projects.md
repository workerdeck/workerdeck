---
title: Project identity
description: A `.workerdeck.json` gives a directory a name and an icon, so a list of sessions reads as a list of projects instead of a column of folder basenames.
order: 10
---

A gateway with twenty sessions on it shows you twenty rows, and the only thing distinguishing
them is the tail of a path. `ui`, `server`, `web` — three rows of one repo, and nothing says so.
A `.workerdeck.json` fixes that by giving a directory a name and an icon.

```json
{
  "name": "WorkerDeck",
  "icon": "docs/assets/icon.png"
}
```

Drop that at the root of a repo and every session started anywhere inside it — including in
`packages/ui` — reports the project on `SessionInfo.project`. Every client draws it, and
sessions can be filtered, grouped and sorted by it.

Nothing else changes: it is a **display declaration**. No session behaves differently for
having one, and a missing, malformed or oversized file degrades silently to the folder
basename, which is exactly what shipped before this existed.

## How a project is found

The **gateway** resolves it, not the client. The file lives on the gateway's filesystem, and a
phone or a browser talking to a remote gateway cannot see that filesystem at all — a per-client
reader would make the feature work on one client and not the others.

Resolution is an ancestor walk from the session's cwd, nearest wins — git's own discovery. The
directory holding the file is the project **root**, and that root is the grouping key, never the
name: two repos are both called `api`, and renaming one must not empty a saved filter.

It is stamped at serve time and never persisted, so editing the file reaches every session
within the cache TTL (30s) with no restart and no migration of stored records.

## Icons

Two forms. A **glyph** costs nothing and is the easy default:

```json
{ "name": "Zigby", "icon": "tree-pine" }
```

Any [lucide](https://lucide.dev) name in lowercase kebab-case. The gateway validates the
*shape* only — it carries no icon catalog — so an unknown-but-well-formed name ships and the
client falls back to a folder. The web clients carry a curated 110-glyph table (a namespace
import over lucide's ~1,600 measured 927 KB against 77 KB); iOS maps 111 names onto SF Symbols.
Either way, an unmapped name draws a folder rather than nothing.

An **image** is a path relative to the project root:

```json
{ "name": "WorkerDeck", "icon": "docs/assets/icon.png" }
```

`.png` and `.svg` only, up to 512 KB. The wire carries an *address* — media type, and a content
hash — and the bytes come from `GET /sessions/:id/project/icon`. That is deliberate:
`SessionInfo` rides every row of a 1.2s poll, so an inlined icon would be thirty copies a second
of something that never changes. Clients cache by the hash, which means one request serves
twelve rows of the same repo, and an edited icon arrives as a new key rather than going stale.

### Prefer PNG if you use a phone

**iOS cannot decode an SVG from bytes.** ImageIO lists 62 decodable types and none of them is
SVG; asset catalogs convert at compile time, which a downloaded blob cannot use. An
`image/svg+xml` icon therefore degrades to the name alone on the phone, while rendering
normally in the dashboard and in VS Code.

Rasterising on the gateway was considered and rejected: the session cwd *is* the agent's working
tree, so converting would mean running an SVG parser over agent-writable input on the shared
gateway. The icon route deliberately parses nothing — it serves bytes with `nosniff` and an
attachment disposition precisely so that a hostile file is inert.

If your project should show its mark on every client, ship a PNG.

## Security

The icon path comes out of a file the *agent* can write, so it gets the host-filesystem
treatment rather than the session-cwd one: the declared path is resolved against the project
root, realpath'd whole, and containment is decided on the canonical result. `"icon":
"../../../../etc/key.png"` and a planted symlink fail the same single check.

Every refusal is the same 404 as "no icon declared" — distinguishing them would say *why* a path
was refused. The route takes no client input beyond the session id: it serves whatever the
gateway's own discovery resolved, so there is nothing to point somewhere else.

## What each client does with it

The clients agree on the rules and differ where the surface genuinely differs.

- **VS Code** puts the project in the sidebar card's second line, in place of the cwd basename
  it was only ever a proxy for.
- **The dashboard** does the same through `SessionBrowser`, with the icon on project group
  headers too.
- **iOS** is the one that diverges, and deliberately: the phone is the only client that draws
  the whole cwd, so replacing it with a name would remove information the others never had.
  It prefixes instead — `WorkerDeck · packages/ui` — dropping the relative half when the session
  sits at the root.

When a list is **grouped by project**, the row's slot hands back to the folder basename: inside
a WorkerDeck group, `ui` / `server` / `web` is the one thing the group header cannot tell you.
