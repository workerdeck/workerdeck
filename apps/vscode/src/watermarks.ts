import type * as vscode from 'vscode'
import { Watermarks } from '@workerdeck/protocol'
import type { Watermark, WatermarkStore } from '@workerdeck/protocol'

export type { Watermark }
export { unseenCount } from '@workerdeck/protocol'

const KEY = 'workerdeck.watermarks.v1'

export function createWatermarks(context: vscode.ExtensionContext): Watermarks {
  const store: WatermarkStore = {
    read: () => context.globalState.get<Record<string, Watermark>>(KEY),
    // Fire-and-forget: a Memento update that loses a race re-runs on the next mark a minute later.
    write: (marks) => void context.globalState.update(KEY, marks),
  }
  return new Watermarks(store)
}

export { Watermarks }
