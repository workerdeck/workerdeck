import * as vscode from 'vscode'
import { Watermarks } from '@workerdeck/protocol'
import type { Watermark, WatermarkStore } from '@workerdeck/protocol'

/**
 * The unread model, backed by `globalState`.
 *
 * The rules — monotonicity, the once-a-minute touch, the 30-day prune, and
 * `unseenCount`'s rows-not-turns arithmetic — live in `@workerdeck/protocol`,
 * because the dashboard counts unread the same way and a second implementation
 * would drift. All that is VS Code-shaped is where the marks are kept.
 */
export type { Watermark }
export { unseenCount } from '@workerdeck/protocol'

const KEY = 'workerdeck.watermarks.v1'

export function createWatermarks(context: vscode.ExtensionContext): Watermarks {
  const store: WatermarkStore = {
    read: () => context.globalState.get<Record<string, Watermark>>(KEY),
    // Fire-and-forget: nothing downstream waits on the write, and a Memento
    // update that loses a race re-runs on the next mark a minute later.
    write: (marks) => void context.globalState.update(KEY, marks),
  }
  return new Watermarks(store)
}

export { Watermarks }
