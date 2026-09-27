import type { ReactNode } from 'react'
import { FileLinkProvider, type FileLinkHandle } from '../terminal/file-link.tsx'
import { ShellActionsProvider, type ShellActions } from './shell-actions.tsx'
import { ToolResultFetchProvider, type ToolResultFetcher } from './tool-result-fetch.tsx'
import { ToolResultImageProvider, type ToolResultImageLoader } from './tool-result-image.tsx'
import { ToolTitleProvider } from './tool-titles.tsx'
import { TranscriptVariantProvider, type TranscriptVariant } from './transcript-variant.tsx'

type SessionPanelProvidersProps = {
  variant: TranscriptVariant
  fileLinks: FileLinkHandle | undefined
  loadFullResult: ToolResultFetcher
  shellActions: ShellActions
  toolTitles: Record<string, string> | undefined
  resultImages: ToolResultImageLoader
  children: ReactNode
}

export function SessionPanelProviders({
  variant,
  fileLinks,
  loadFullResult,
  shellActions,
  toolTitles,
  resultImages,
  children,
}: SessionPanelProvidersProps) {
  return (
    <TranscriptVariantProvider value={variant}>
      <FileLinkProvider value={fileLinks}>
        <ToolResultFetchProvider value={loadFullResult}>
          <ShellActionsProvider value={shellActions}>
            <ToolTitleProvider value={toolTitles}>
              <ToolResultImageProvider value={resultImages}>{children}</ToolResultImageProvider>
            </ToolTitleProvider>
          </ShellActionsProvider>
        </ToolResultFetchProvider>
      </FileLinkProvider>
    </TranscriptVariantProvider>
  )
}
