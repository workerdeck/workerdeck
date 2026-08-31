import type { ReactNode } from 'react'
import type { OpenFile } from '@workerdeck/react'
import { currentText, isDirty } from '@workerdeck/react'
import { FileWarning, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { CodeEditor } from './CodeEditor.tsx'

export interface FileViewerProps {
  file: OpenFile | undefined
  canWrite?: boolean
  onChange?: (path: string, content: string) => void
  onSave?: (path: string) => void
  onRevert?: (path: string) => void
  onReload?: (path: string) => void
  onOverwrite?: (path: string) => void
  onDismissConflict?: (path: string) => void
  className?: string
}

export function FileViewer({
  file,
  canWrite,
  onChange,
  onSave,
  onRevert,
  onReload,
  onOverwrite,
  onDismissConflict,
  className,
}: FileViewerProps) {
  if (!file) {
    return null
  }

  return (
    <div data-slot="file-viewer" className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-bg', className)}>
      {file.conflict ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warning/40 bg-warning-bg px-3 py-2">
          <TriangleAlert className="size-3.5 shrink-0 text-warning" />
          <span className="min-w-0 flex-1 text-body-sm text-warning">This file changed on disk since you opened it.</span>
          <Button variant="outline" size="xs" onClick={() => onReload?.(file.path)}>
            Use the version on disk
          </Button>
          <Button variant="outline" size="xs" onClick={() => onOverwrite?.(file.path)}>
            Keep mine
          </Button>
          <Button variant="ghost" size="xs" onClick={() => onDismissConflict?.(file.path)}>
            Dismiss
          </Button>
        </div>
      ) : file.saveError ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/40 bg-danger-bg px-3 py-2">
          <TriangleAlert className="size-3.5 shrink-0 text-danger" />
          <span className="min-w-0 flex-1 text-body-sm text-danger">{file.saveError}</span>
          <Button variant="ghost" size="xs" onClick={() => onDismissConflict?.(file.path)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {file.status === 'loading' ? (
        <Centred>
          <Spinner className="size-4 text-fg-4" />
        </Centred>
      ) : file.status === 'error' ? (
        <Centred>
          <TriangleAlert className="size-4 text-danger" />
          <p className="text-body-sm text-danger">{file.error}</p>
        </Centred>
      ) : file.status === 'binary' ? (
        <Centred>
          <FileWarning className="size-4 text-fg-4" />
          <p className="text-body-sm text-fg-4">This file isn’t text.</p>
          <p className="text-label text-fg-4">It can’t be edited here without corrupting it.</p>
        </Centred>
      ) : (
        <CodeEditor
          path={file.path}
          value={currentText(file)}
          readOnly={!canWrite}
          onChange={onChange ? (content) => onChange(file.path, content) : undefined}
          onSave={onSave ? () => onSave(file.path) : undefined}
        />
      )}

      {file.status === 'ready' && (file.saving || isDirty(file) || !canWrite) ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1">
          {file.saving ? (
            <>
              <Spinner className="size-3 text-fg-4" />
              <span className="text-label text-fg-4">Saving…</span>
            </>
          ) : !canWrite ? (
            <span className="text-label text-fg-4">Read-only — this gateway doesn’t allow writes.</span>
          ) : (
            <>
              <span className="text-label text-fg-3">Unsaved changes</span>
              <span className="flex-1" />
              <Button variant="ghost" size="xs" onClick={() => onRevert?.(file.path)}>
                Revert
              </Button>
              <Button variant="outline" size="xs" onClick={() => onSave?.(file.path)}>
                Save
                <span className="ml-1 text-fg-4">⌘S</span>
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function Centred({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6">{children}</div>
}
