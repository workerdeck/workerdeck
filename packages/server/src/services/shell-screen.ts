import xtermHeadless from '@xterm/headless'
import type { Terminal } from '@xterm/headless'

// What the terminal shows right now, kept by a headless emulator fed the same bytes as the artifact. A redrawing
// program flattens into every frame it ever painted; the screen is the only view of it a reader can use.
export class ShellScreen {
  #term: Terminal | undefined
  #closing: Promise<void> | undefined
  #final: string | undefined

  constructor(cols: number, rows: number) {
    this.#term = new xtermHeadless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  }

  write(data: string): void {
    this.#term?.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.#term?.resize(cols, rows)
    } catch {}
  }

  async snapshot(): Promise<string> {
    if (this.#closing) {
      await this.#closing
    }
    if (this.#final !== undefined) {
      return this.#final
    }
    const term = this.#term
    if (!term) {
      return ''
    }
    await drained(term)
    return render(term)
  }

  // DECCKM as the program last set it, so a cursor key is encoded the way the program expects to read it.
  async applicationCursorKeys(): Promise<boolean> {
    const term = this.#term
    if (!term) {
      return false
    }
    await drained(term)
    return term.modes.applicationCursorKeysMode
  }

  // An exited shell keeps its last screen as a string, not an emulator.
  close(): void {
    const term = this.#term
    if (!term || this.#closing) {
      return
    }
    this.#term = undefined
    this.#closing = drained(term).then(() => {
      this.#final = render(term)
      term.dispose()
    })
  }
}

export async function renderScreen(raw: string, cols: number, rows: number): Promise<string> {
  const screen = new ShellScreen(cols, rows)
  screen.write(raw)
  screen.close()
  return screen.snapshot()
}

function drained(term: Terminal): Promise<void> {
  return new Promise((resolve) => term.write('', resolve))
}

function render(term: Terminal): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < term.rows; y++) {
    lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.join('\n')
}
