import type { ModelCatalog } from '../adapter.ts'

/**
 * The Codex engine's model catalog, seeded from the binary's own embedded
 * presets — `@openai/codex@0.146.0` ships its model table inside the
 * executable, and that table (not the SDK's stale `ModelReasoningEffort`
 * union) is the truth about which reasoning efforts each model takes.
 *
 * **Refresh procedure** (release checklist): extract the embedded JSON from
 * the platform binary and diff —
 *
 *   node -e 'const d=require("fs").readFileSync(process.argv[1]);
 *     const s=d.indexOf(`{\n  "models": [`);
 *     let i=s,n=0; do{n+=(d[i]===123)-(d[i]===125);i++}while(n);
 *     const c=JSON.parse(d.slice(s,i));
 *     for(const m of c.models) console.log(m.slug, m.display_name,
 *       m.visibility, m.supported_reasoning_levels.map(l=>l.effort).join(","))'\
 *     "$(node -p 'const{createRequire}=require("module");
 *       const w=require.resolve("@openai/codex/package.json");
 *       createRequire(w).resolve("@openai/codex-darwin-arm64/package.json")
 *         .replace("package.json","vendor/aarch64-apple-darwin/bin/codex")')"
 *
 * The two-hop resolve is NOT optional: under pnpm's strict layout the platform
 * package is a dependency of `@openai/codex`, so it resolves only from that
 * wrapper's location, never from the repo root. Resolving it directly throws
 * MODULE_NOT_FOUND — the same two hops `resolveBundledCodexExecutable` makes.
 *
 * Mapping decisions:
 * - the internal `codex-auto-review` row is dropped (the codex analogue of
 *   dropping the CLI's `default` sentinel);
 * - `primary` mirrors the binary's own `visibility` field ('list' = shown in
 *   its picker, 'hide' = its "older models"), so both UIs group the way
 *   codex's own picker does;
 * - `reasoningEfforts` carries `supported_reasoning_levels` verbatim — note
 *   `max`/`ultra` beyond the SDK union; trust the binary, keep strings open.
 */
export const CODEX_CATALOG: ModelCatalog = {
  provenance: 'embedded model presets of @openai/codex@0.149.0 (darwin-arm64 binary), extracted 2026-08-22',
  models: [
    {
      value: 'gpt-5.6-sol',
      resolvedModel: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'gpt-5.5',
      resolvedModel: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'gpt-5.4',
      resolvedModel: 'gpt-5.4',
      displayName: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'gpt-5.4-mini',
      resolvedModel: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'gpt-5.2',
      resolvedModel: 'gpt-5.2',
      displayName: 'GPT-5.2',
      description: 'Optimized for professional work and long-running agents.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
}
