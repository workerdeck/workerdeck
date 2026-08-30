/**
 * What an attach is actually made of, on the wire. No API key, no cost — it
 * attaches to a session that already exists on a running gateway.
 *
 *   pnpm smoke:attach <host> <sessionId> [truncate] [refs] [--capture <file>]
 *   pnpm smoke:attach 127.0.0.1:8787 abc123
 *   pnpm smoke:attach 127.0.0.1:8787 abc123 truncate refs
 *
 * **This exists because a replay rule's justification is not its measurement.**
 * `truncateResults` shipped on a projection of 68% and was worth 0.3% when it
 * was finally run: the projection had measured `JSON.stringify(content).length`
 * and so counted base64 image parts as text. This script keeps text and
 * non-text parts apart precisely so that mistake cannot be repeated — run it
 * before calling any new replay rule finished (see `docs/PACKAGES.md`, the
 * `packages/protocol` section, for the family of rules it applies to).
 *
 * `--capture <file>` writes every frame as JSONL instead of summarising, which
 * is how you prove a control session is byte-identical across a rule:
 *
 *   pnpm smoke:attach $HOST $ID --capture /tmp/before.jsonl
 *   pnpm smoke:attach $HOST $ID refs --capture /tmp/after.jsonl
 *   diff /tmp/before.jsonl /tmp/after.jsonl     # must be empty on a no-image session
 */
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const argv = process.argv.slice(2)
const captureAt = argv.indexOf('--capture')
const capture = captureAt === -1 ? undefined : argv[captureAt + 1]
const rest = captureAt === -1 ? argv : [...argv.slice(0, captureAt), ...argv.slice(captureAt + 2)]
const [host, id, ...flags] = rest

if (!host || !id) {
  console.error('usage: pnpm smoke:attach <host> <sessionId> [truncate] [refs] [--capture <file>]')
  process.exit(2)
}
if (captureAt !== -1 && !capture) {
  console.error('--capture needs a file path')
  process.exit(2)
}

const trunc = flags.includes('truncate')
const refs = flags.includes('refs')
const query = `afterSeq=0${trunc ? '&truncateResults=1' : ''}${refs ? '&imageRefs=1' : ''}`
const ws = new WebSocket(`ws://${host}/v1/sessions/${id}/ws?${query}`)

const raw: string[] = []
const byType = new Map<string, number>()
const largestText: number[] = []
const largestFrames: { seq: number; type: string; bytes: number }[] = []
let total = 0
let frames = 0
let blocks = 0
let textChars = 0
let nonTextBytes = 0
let over8k = 0
let cuttable = 0
let target = Infinity
let done = false

ws.on('message', (buf: Buffer) => {
  const line = buf.toString()
  const envelope = JSON.parse(line)
  if (capture) {
    raw.push(line)
  }
  if (envelope.type === 'attached') {
    target = envelope.session.lastSeq
    return
  }
  const event = envelope.event
  if (!event) {
    return
  }

  total += buf.length
  frames++
  byType.set(event.type, (byType.get(event.type) ?? 0) + buf.length)
  largestFrames.push({ seq: event.seq, type: event.type, bytes: buf.length })

  // Tool results ride on `user_message`; a block's `content` is either a plain
  // string or an array of parts, only some of which are text.
  if (event.type === 'user_message' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') {
        continue
      }
      blocks++
      let text = 0
      let other = 0
      if (typeof block.content === 'string') {
        text = block.content.length
      } else if (Array.isArray(block.content)) {
        for (const part of block.content) {
          if (typeof part.text === 'string') {
            text += part.text.length
          } else {
            other += JSON.stringify(part).length
          }
        }
      }
      textChars += text
      nonTextBytes += other
      largestText.push(text)
      if (text > 8000) {
        over8k++
        cuttable += text - 8000
      }
    }
  }

  if (event.seq >= target) {
    finish()
  }
})

ws.on('error', (err: Error) => {
  console.error(`socket error: ${err.message}`)
  process.exit(1)
})

const KB = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`

const finish = (): void => {
  if (done) {
    return
  }
  done = true
  ws.close()

  if (capture) {
    writeFileSync(capture, `${raw.join('\n')}\n`)
    console.log(`${raw.length} frames -> ${capture}`)
    process.exit(0)
  }

  const applied = [trunc && 'truncateResults=1', refs && 'imageRefs=1'].filter(Boolean).join(' ')
  console.log(`attach ${KB(total)} in ${frames} frames${applied ? ` (${applied})` : ''}`)
  for (const [type, bytes] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(18)} ${KB(bytes).padStart(9)}`)
  }

  console.log(`tool_result blocks: ${blocks}`)
  console.log(`  text          ${textChars.toLocaleString()} chars`)
  console.log(`  non-text      ${KB(nonTextBytes)}  <- base64 parts; the reducer discards these`)
  console.log(`  over 8k text  ${over8k} blocks, ${KB(cuttable)} the text rule can cut`)
  console.log(
    `  largest text results: ${largestText
      .sort((a, b) => b - a)
      .slice(0, 8)
      .join(', ')}`,
  )
  console.log(
    `  largest frames: ${largestFrames
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 4)
      .map((f) => `seq ${f.seq} ${f.type} ${KB(f.bytes)}`)
      .join(' | ')}`,
  )
  process.exit(0)
}

setTimeout(() => {
  console.log('TIMEOUT — the session never reached its lastSeq')
  finish()
}, 60_000)
