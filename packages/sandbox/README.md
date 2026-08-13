# @workerdeck/sandbox

Execution sandbox for untrusted, LLM-generated scripts: a QuickJS-NG guest compiled to
WebAssembly, an in-memory scratch filesystem, and a hardened by-value host bridge. Deny-by-default
— the guest has no filesystem, network, timers, or host access except the capabilities you grant.

Part of [WorkerDeck](https://github.com/workerdeck/workerdeck). Leaf package: it
depends on neither `core`/`server` nor any model SDK, so the same guest engine runs server-side
(Node) and in a browser tab.

## Install

```bash
npm install @workerdeck/sandbox @jitl/quickjs-ng-wasmfile-release-asyncify
```

The WASM engine variant is injected rather than bundled, so you pick the build that fits your
target: `@jitl/quickjs-ng-wasmfile-release-asyncify` on the server,
`@jitl/quickjs-singlefile-browser-release-asyncify` in the browser (no separate `.wasm` fetch).
Use an **asyncify** variant — it lets guest code `await` a host function.

## Usage

```ts
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, runScript } from '@workerdeck/sandbox'

// Load once and reuse; the module is stateless.
const engine = await loadEngine(variant)

const vfs = createVfs({ '/docs/report.txt': 'revenue: 12' })

const result = await runScript(engine, {
  script: `
    const doc = vfs.read('/docs/report.txt')
    const revenue = Number(doc.split(':')[1])
    vfs.write('/out/score.json', JSON.stringify({ revenue }))
    revenue > 10 ? 'qualified' : 'skip'
  `,
  vfs,
  memoryLimitBytes: 64 * 1024 * 1024,
  timeoutMs: 5000,
})

if (result.ok) console.log(result.value, vfs.snapshot())
else console.error(result.reason, result.error)
```

`runScript` never throws for guest misbehavior: exceptions, timeouts, and out-of-memory all come
back as `{ ok: false, reason }` so an agent loop can adapt to them.

## What the guest can reach

Everything is granted explicitly; there is no ambient authority.

| Guest global | Backed by | Notes |
| --- | --- | --- |
| `console.log/warn/error` | captured | returned as `result.logs`, never written to the host console |
| `vfs.read/write/list` | the `vfs` option | absent-file reads return `undefined`; omit the option and writes throw |
| `fetchText(url)` | the `fetchText` option | omit it and the guest throws; **you** own the allowlist |

Absent by construction: `process`, `require`, `fetch`, `XMLHttpRequest`, `setTimeout`,
`setInterval`, `WebAssembly`, and any module loader.

## Limits

`memoryLimitBytes` (default 64 MiB) caps the QuickJS allocator, and `timeoutMs` (default 5000) is
enforced by an interrupt handler that runs between bytecode operations — so an infinite loop is
preempted in-thread, with no worker and no cross-origin isolation. Each call gets a fresh runtime
and context; nothing carries over between runs.

**The deadline does not cover time spent inside your host functions.** The interpreter is not
executing while a host call is in flight, so put an independent timeout on every capability you
grant — especially `fetchText`.

## Security model

The WebAssembly boundary is the easy part; the host bridge is the attack surface. Values cross it
**by value only** (strings and JSON), and a host object is never handed to the guest by reference.
That rule is what the guest-realm escape test exercises: walking `({}).constructor.constructor`
to `globalThis` succeeds, and lands in the guest's own realm with nothing of the host's in it.
This is the failure mode behind CVE-2026-5752, where a mock object's prototype chain leaked a
path to the host's `require()`.

If you extend the bridge, keep to it: marshal by value, freeze or null-prototype anything you
construct for the guest, and give every capability its own timeout.

## Rules you cannot infer from the types

- **The VFS is a map, not a filesystem.** It is deliberately not a `node:fs` emulation: the
  tab-side host runs it unpolyfilled, and one shared implementation across server and browser is
  the point.
- **The engine variant is injected, never imported here.** The browser single-file build and the
  server WASM-file build are different artifacts; only the host knows which side it is on.
- **The deadline preempts between bytecode ops, on whichever thread the guest runs.** In a tab
  that is the UI thread unless you supply your own `execute` running the same engine in a Worker —
  a time-boxed evaluation still blocks paint while it runs.
- **Guest results are untrusted input.** Whatever the sandbox returns was produced by the party you
  sandboxed against, which is the whole reason it may be bridged to a browser at all.

## License

MIT
