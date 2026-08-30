/**
 * Formatting helpers on their own entry point: pure and dependency-free, so a host
 * rendering session readings outside React (the VS Code window status bar) spells
 * them the same way without pulling in React and every component.
 */
export * from './lib/format.ts'
export * from './lib/status.ts'
