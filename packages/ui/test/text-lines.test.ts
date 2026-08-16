import { describe, expect, it } from 'vitest'
import { textLines } from '../src/components/terminal/height.ts'

/**
 * The one genuinely unit-testable piece of the height calculator.
 *
 * Everything around it — does the rendered row come out the pixel height this
 * predicted — is checked in `dev/height-audit.ts` against real browser layout,
 * because jsdom has no text layout and a jsdom test would only check the
 * calculator against its author's assumptions. Line *counting* at a column width
 * is arithmetic, and that is what is pinned here.
 *
 * `exact` is the other half of the contract and is not a confidence score: it is
 * the calculator flagging what it cannot know, so the row self-corrects on
 * mount. A row that claimed `exact` wrongly is the failure mode — it never
 * remeasures.
 */
describe('textLines', () => {
  it('is one line for anything that fits', () => {
    expect(textLines('hello', 80)).toEqual({ lines: 1, exact: true })
  })

  it('is one line for empty text, never zero', () => {
    expect(textLines('', 80).lines).toBe(1)
  })

  it('counts hard lines', () => {
    expect(textLines('a\nb\nc', 80).lines).toBe(3)
  })

  it('counts a trailing newline’s empty line', () => {
    expect(textLines('a\n', 80).lines).toBe(2)
  })

  it('wraps on word boundaries, not mid-word', () => {
    // Three 5-char words in 12 columns: "alpha beta" fits (10), "gamma" does not.
    expect(textLines('alpha beta gamma', 12).lines).toBe(2)
  })

  it('hangs preserved spaces past the line end rather than wrapping for them', () => {
    // CSS Text 3: trailing spaces may overflow without forcing a wrap. The
    // discriminating case is spaces that push *past* `cols` — a run that merely
    // fits proves nothing. Getting this wrong adds a phantom line to every row
    // that happens to end in whitespace.
    expect(textLines(`${'x'.repeat(10)}   `, 10).lines).toBe(1)
    // …and the word after them still starts the next line.
    expect(textLines(`${'x'.repeat(10)}   y`, 10).lines).toBe(2)
  })

  it('breaks a word longer than the line across whole lines', () => {
    expect(textLines('x'.repeat(30), 10).lines).toBe(3)
    expect(textLines('x'.repeat(31), 10).lines).toBe(4)
  })

  it('moves an over-long word to its own line before filling', () => {
    // 'ab ' then a 20-char token at 10 columns: the token leaves the first line,
    // then takes two of its own.
    expect(textLines(`ab ${'x'.repeat(20)}`, 10).lines).toBe(3)
  })

  it('is one inexact line at a nonsensical width rather than dividing by it', () => {
    expect(textLines('anything', 0)).toEqual({ lines: 1, exact: false })
    expect(textLines('anything', -5)).toEqual({ lines: 1, exact: false })
  })

  it('flags CJK as inexact — its advance is not one cell', () => {
    const cjk = textLines('日本語のテキスト', 80)
    expect(cjk.exact).toBe(false)
  })

  it('flags an emoji as inexact', () => {
    expect(textLines('done ✅', 80).exact).toBe(false)
  })

  it('stays exact for plain ASCII, wrapped or not', () => {
    expect(textLines('a '.repeat(200), 40).exact).toBe(true)
  })

  it('propagates inexactness from any one hard line to the whole', () => {
    expect(textLines('plain ascii\n日本語', 80).exact).toBe(false)
  })
})
