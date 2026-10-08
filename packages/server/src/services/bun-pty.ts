import type { PtyChild, PtyModule } from './shell-types.ts'

type BunTerminal = {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

type BunSubprocess = {
  readonly pid: number
  readonly exited: Promise<number>
  readonly signalCode: string | null
  readonly terminal: BunTerminal
  kill: (signal?: string | number) => void
}

type BunSpawnOptions = {
  cwd: string
  env: Record<string, string>
  terminal: { cols: number; rows: number; name?: string; data: (terminal: BunTerminal, data: Uint8Array) => void }
}

type BunRuntime = { spawn: (cmd: string[], options: BunSpawnOptions) => BunSubprocess }

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }

export function bunRuntime(): BunRuntime | undefined {
  const bun = (globalThis as { Bun?: Partial<BunRuntime> }).Bun
  return typeof bun?.spawn === 'function' ? (bun as BunRuntime) : undefined
}

// node-pty's spawn-helper never execs under Bun (1.4.2), so a Bun host gets Bun's own PTY behind the same seam.
export function createBunPty(bun: BunRuntime): PtyModule {
  return {
    spawn: (file, args, options) => {
      const decoder = new TextDecoder()
      const dataListeners: ((data: string) => void)[] = []
      const exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = []
      let pending = ''
      let exit: { exitCode: number; signal?: number } | undefined
      const emit = (text: string): void => {
        if (text === '') {
          return
        }
        if (dataListeners.length === 0) {
          pending += text
          return
        }
        for (const listener of dataListeners) {
          listener(text)
        }
      }
      const proc = bun.spawn([file, ...args], {
        cwd: options.cwd,
        env: options.env,
        terminal: {
          cols: options.cols,
          rows: options.rows,
          name: options.name,
          data: (_terminal, data) => emit(decoder.decode(data, { stream: true })),
        },
      })
      void proc.exited.then((exitCode) => {
        setTimeout(() => {
          emit(decoder.decode())
          const signal = proc.signalCode ? SIGNALS[proc.signalCode] : undefined
          exit = signal === undefined ? { exitCode } : { exitCode, signal }
          for (const listener of exitListeners) {
            listener(exit)
          }
          try {
            proc.terminal.close()
          } catch {}
        }, 0)
      })
      const child: PtyChild = {
        pid: proc.pid,
        onData: (listener) => {
          dataListeners.push(listener)
          if (pending !== '') {
            const flushed = pending
            pending = ''
            listener(flushed)
          }
        },
        onExit: (listener) => {
          exitListeners.push(listener)
          if (exit) {
            listener(exit)
          }
        },
        write: (data) => {
          if (!exit) {
            proc.terminal.write(data)
          }
        },
        resize: (cols, rows) => {
          if (!exit) {
            proc.terminal.resize(cols, rows)
          }
        },
        kill: (signal) => {
          if (!exit) {
            proc.kill(signal ?? 'SIGHUP')
          }
        },
      }
      return child
    },
  }
}
