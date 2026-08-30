/**
 * The workspace layer — the VS Code-shaped layout around `SessionPanel`, and the
 * Monaco editor at the middle of it.
 *
 * A separate entry point (`@workerdeck/ui/workspace`) so Monaco is unreachable from
 * the root entry: Vite resolves its `new Worker(new URL(…))` calls during transform,
 * before tree-shaking, and emits ~9MB of never-retracted worker assets. `monaco-editor`
 * is therefore an optional peer dependency; see the README for its Vite config.
 */

export { SessionWorkspace, type SessionWorkspaceProps } from './components/agent/SessionWorkspace.tsx'
export { FileTree, type FileTreeProps } from './components/agent/FileTree.tsx'
export { EditorTabs, type EditorTabsProps } from './components/agent/EditorTabs.tsx'
export { FileViewer, type FileViewerProps } from './components/agent/FileViewer.tsx'
export { CodeEditor, type CodeEditorProps } from './components/agent/CodeEditor.tsx'
