import { open, stat } from 'node:fs/promises'
import { unwatchFile, watchFile } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import * as vscode from 'vscode'

const POLL_MS = 1000
const BACKLOG_BYTES = 64 * 1024

// The server writes to a file rather than a pipe, because it has to outlive this window - so the
// Output channel is fed by tailing that file. It is also what lets a window show the log of a
// server it merely *adopted*, which a pipe from our own child could never do.
export class LogTail implements vscode.Disposable {
  readonly #channel: vscode.OutputChannel
  readonly #decoder = new StringDecoder('utf8')
  #path: string | undefined
  #offset = 0
  #reading = false

  constructor() {
    this.#channel = vscode.window.createOutputChannel('WorkerDeck Server')
  }

  async follow(path: string): Promise<void> {
    if (this.#path === path) {
      return
    }
    this.stop()
    this.#path = path
    this.#channel.clear()
    // Open on the tail rather than the whole file: this log is append-only across every run the
    // state dir has ever seen, and the interesting part is always the end.
    try {
      const { size } = await stat(path)
      this.#offset = Math.max(0, size - BACKLOG_BYTES)
    } catch {
      this.#offset = 0
    }
    watchFile(path, { interval: POLL_MS }, () => void this.#drain())
    await this.#drain()
  }

  show(): void {
    this.#channel.show(true)
  }

  note(line: string): void {
    this.#channel.appendLine(`[workerdeck-vscode] ${line}`)
  }

  async #drain(): Promise<void> {
    const path = this.#path
    if (!path || this.#reading) {
      return
    }
    this.#reading = true
    try {
      const { size } = await stat(path)
      // A smaller file is a new one: the log was rotated or the state dir was cleared under us.
      if (size < this.#offset) {
        this.#offset = 0
        this.#channel.clear()
      }
      if (size === this.#offset) {
        return
      }
      const handle = await open(path, 'r')
      try {
        const buffer = Buffer.alloc(size - this.#offset)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.#offset)
        this.#offset += bytesRead
        // Through the decoder, because a read can land mid-codepoint and `toString` would emit U+FFFD.
        const text = this.#decoder.write(buffer.subarray(0, bytesRead))
        if (text) {
          this.#channel.append(text)
        }
      } finally {
        await handle.close()
      }
    } catch {
      // The file may not exist until the server's first write; the next poll picks it up.
    } finally {
      this.#reading = false
    }
  }

  stop(): void {
    if (this.#path) {
      unwatchFile(this.#path)
    }
    this.#path = undefined
    this.#offset = 0
  }

  dispose(): void {
    this.stop()
    this.#channel.dispose()
  }
}
