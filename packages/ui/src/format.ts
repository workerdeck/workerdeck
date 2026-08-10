/**
 * The formatting helpers, on their own entry point.
 *
 * `src/index.ts` pulls in React and every component with it; a host that renders
 * session readings *outside* React — the VS Code extension host drawing them in
 * the window status bar, say — needs the numbers spelled the same way without
 * paying for that. These functions are pure and dependency-free, so the subpath
 * costs nothing and keeps one truth for what "45.2k" and "2h 10m" mean.
 */
export * from './lib/format.ts'
