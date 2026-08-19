/**
 * The one shared-state record every route module takes. Built once inside
 * `createWorkerServer` after assembly; routes destructure what they need.
 * Nothing here is optional at request time — the assembly fills every field
 * before the server accepts a connection.
 */
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
  /** Injectable claude lister for GET /sdk-sessions (tests). */
  listSdkSessions?: SdkSessionLister

  profiles: ProfileService
  availability: AvailabilityTracker
  auth: AuthService
  factory: SessionFactory

  registry: SessionRegistry
  parking: SessionParkManager
  bridge: BridgeHub
  /** Serve-time `.workerdeck.json` discovery — every route that writes a
   * `SessionInfo` to a client stamps `project` through `withProject`. */
  projects: ProjectInfoService
  queue: JobQueue | undefined
  attachmentStore: AttachmentStore
  producedFiles: ProducedFileStore

  /** Host filesystem routes; null = the routes do not exist. */
  hostFiles: HostFileRoots | null
  hostFilesWritable: boolean
  maxHostFileBytes: number
  maxHostDirEntries: number
}
