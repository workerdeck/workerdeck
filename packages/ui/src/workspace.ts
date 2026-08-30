/**
 * The workspace layer — the VS Code-shaped layout around `SessionPanel`, and
 * the Monaco editor at the middle of it.
 *
 * This is a **separate entry point** (`@workerdeck/ui/workspace`) for one
 * reason: Monaco. It is only reachable from here, so an embedder who imports
 * the root entry never pulls it into their module graph.
 *
 * That matters more than tree-shaking alone would suggest. Rollup does drop
 * `CodeEditor` from a `SessionPanel`-only bundle — but Vite resolves Monaco's
 * `new Worker(new URL(…, import.meta.url))` calls during *transform*, before
 * tree-shaking runs, and emits ~9MB of language-service workers as assets that
 * are never retracted. Keeping the import unreachable from the root entry is
 * what actually prevents that; `sideEffects: false` does not.
 *
 * Consequently `monaco-editor` is an **optional peer dependency**: importing
 * this entry means installing it, and importing only the root entry means not
 * having to. See the README for the Vite configuration Monaco needs.
 */

export { SessionWorkspace, type SessionWorkspaceProps } from './components/agent/SessionWorkspace.tsx'
export { FileTree, type FileTreeProps } from './components/agent/FileTree.tsx'
export { EditorTabs, type EditorTabsProps } from './components/agent/EditorTabs.tsx'
export { FileViewer, type FileViewerProps } from './components/agent/FileViewer.tsx'
export { CodeEditor, type CodeEditorProps } from './components/agent/CodeEditor.tsx'
