import type { EngineAdapter } from '@workerdeck/core'
import type { JobQueue } from '@workerdeck/queue'
import type { ProfileEngine } from '@workerdeck/protocol'
import type { SdkSessionLister, WorkerServerOptions } from './options.ts'
import type { AttachmentStore } from './services/attachments.ts'
import type { AuthService } from './services/auth.ts'
import type { AvailabilityTracker } from './services/availability.ts'
import type { BridgeHub } from './services/bridge.ts'
import type { HostFileRoots } from './services/host-files.ts'
import type { SessionParkManager } from './services/parking.ts'
import type { ProducedFileStore } from './services/produced-files.ts'
import type { ProfileService } from './services/profiles.ts'
import type { ProjectInfoService } from './services/project-info.ts'
import type { SessionRegistry } from './services/registry.ts'
import type { SessionFactory } from './services/session-factory.ts'

export type ServerContext = {
  options: WorkerServerOptions
  basePath: string
  maxBodyBytes: number
  adapterFor: (engine: ProfileEngine | undefined) => EngineAdapter
  listSdkSessions?: SdkSessionLister

  profiles: ProfileService
  availability: AvailabilityTracker
  auth: AuthService
  factory: SessionFactory

  registry: SessionRegistry
  parking: SessionParkManager
  bridge: BridgeHub
  projects: ProjectInfoService
  queue: JobQueue | undefined
  attachmentStore: AttachmentStore
  producedFiles: ProducedFileStore

  hostFiles: HostFileRoots | null
  hostFilesWritable: boolean
  maxHostFileBytes: number
  maxHostDirEntries: number
}
