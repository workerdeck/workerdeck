import type { EngineAdapter } from '@workerdeck/core'
import type { JobQueue } from '@workerdeck/queue'
import type { PricingOverrides, ProfileEngine } from '@workerdeck/protocol'
import type { SdkSessionLister, WorkerServerOptions } from './options.ts'
import type { AttachmentStore } from './services/attachments.ts'
import type { AuthService } from './services/auth.ts'
import type { AvailabilityTracker } from './services/availability.ts'
import type { BridgeHub } from './services/bridge.ts'
import type { HostFileRoots } from './services/host-files.ts'
import type { SessionParkManager } from './services/parking.ts'
import type { PeerService } from './services/peers.ts'
import type { ProducedFileStore } from './services/produced-files.ts'
import type { ProfileService } from './services/profiles.ts'
import type { ProjectInfoService } from './services/project-info.ts'
import type { SessionRegistry } from './services/registry.ts'
import type { SessionFactory } from './services/session-factory.ts'
import type { ShellRegistry } from './services/shells.ts'

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
  // Undefined when peer messaging is off; the send path then resolves no `#` mentions.
  peers: PeerService | undefined
  bridge: BridgeHub
  projects: ProjectInfoService
  queue: JobQueue | undefined
  attachmentStore: AttachmentStore
  producedFiles: ProducedFileStore

  hostFiles: HostFileRoots | null
  hostFilesWritable: boolean
  maxHostFileBytes: number
  maxHostDirEntries: number

  shells: ShellRegistry | null
  // Minted per `createWorkerServer`; a shell record stamped with another one was started by a gateway that is gone.
  generation: string
  // The accepted subset of `options.pricing.overrides`, as clients are told them.
  pricingOverrides: PricingOverrides | undefined
}
