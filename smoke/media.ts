/**
 * Manual smoke for MESSAGE ATTACHMENTS against the real Claude Code CLI:
 *
 *   generated file → POST /sessions/:id/attachments → user_message(attachmentIds)
 *   → SessionRunner → CLI → the model actually describing what it was shown
 *
 * Spends tokens — never part of `pnpm test`.
 *
 *   pnpm smoke:media              # all three kinds
 *   pnpm smoke:media image        # just one
 *
 * This is the only thing that can validate the attachment wire. The fake
 * `queryFn` harness in `pnpm test` proves the server builds the right content
 * blocks, but not that the CLI *accepts* them on streamed input — a CLI that
 * dropped non-text blocks would look exactly like a model ignoring the picture.
 * Each case asks a question whose answer is only in the attachment, so a dropped
 * block fails loudly instead of producing a plausible sentence.
 *
 * The files are generated here, not committed: a PNG built byte by byte and a
 * one-page PDF with computed xref offsets, so the repo carries no binaries and
 * the magic words can't leak into the prompt.
 */
import { deflateSync } from 'node:zlib'
import WebSocket from 'ws'
import { WorkerDeckClient } from '@workerdeck/client'
import { createWorkerServer } from '@workerdeck/server'
import type { SessionEvent } from '@workerdeck/protocol'

// ------------------------------------------------------------- fixtures ----

/** CRC-32 (the PNG/zlib one), table built on first use. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xff_ff_ff_ff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xff_ff_ff_ff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/** A solid-colour RGB PNG, `size`×`size`. */
function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  // Each scanline is a filter byte (0 = none) followed by RGB triples.
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b])))])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A one-page PDF showing `text`. Offsets are computed as the objects are laid
 * out — a hand-guessed xref is the usual reason a minimal PDF is rejected. */
function onePagePdf(text: string): Buffer {
  const stream = `BT /F1 36 Tf 60 500 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefAt = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

type Case = {
  kind: string
  name: string
  mediaType: string
  data: Buffer
  prompt: string
  /** The answer must contain one of these, case-insensitively. */
  expect: string[]
}

const CASES: Case[] = [
  {
    kind: 'image',
    name: 'swatch.png',
    mediaType: 'image/png',
    data: solidPng(64, [220, 30, 30]),
    prompt:
      'Look at the attached image. Reply with exactly one word: the colour that fills it. No tools, no preamble.',
    expect: ['red', 'crimson', 'scarlet'],
  },
  {
    kind: 'pdf',
    name: 'memo.pdf',
    mediaType: 'application/pdf',
    data: onePagePdf('VELVET ANTELOPE'),
    prompt:
      'Read the attached PDF and reply with exactly the two words printed on its only page. No tools, no preamble.',
    expect: ['velvet antelope'],
  },
  {
    kind: 'text',
    name: 'notes.txt',
    mediaType: 'text/plain',
    data: Buffer.from('The passphrase is BRASS LANTERN.\n', 'utf8'),
    prompt:
      'The attached file names a passphrase. Reply with exactly that passphrase. No tools, no preamble.',
    expect: ['brass lantern'],
  },
]

const only = process.argv[2]
const cases = only ? CASES.filter((c) => c.kind === only) : CASES
if (cases.length === 0) {
  console.error(`Unknown case '${only}'. Use one of: ${CASES.map((c) => c.kind).join(', ')}`)
  process.exit(1)
}

// --------------------------------------------------------------- harness ----

const server = createWorkerServer({ allowUnauthenticated: true, allowedCwdRoots: ['/tmp'] })
const { port } = await server.listen(0, '127.0.0.1')
const client = new WorkerDeckClient({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
})

console.log(`\nAttachment smoke — real CLI on 127.0.0.1:${port}`)
console.log('='.repeat(60))

const session = await client.createSession({ cwd: '/tmp' })
const handle = client.attach(session.id)

/** Collected assistant text for the turn in flight, resolved on turn_result. */
let inFlight: { text: string[]; done: (text: string) => void } | null = null
handle.on('event', (event: SessionEvent) => {
  if (!inFlight) return
  if (event.type === 'assistant_message') {
    const content = event.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') inFlight.text.push(String((block as { text: string }).text))
      }
    } else if (typeof content === 'string') {
      inFlight.text.push(content)
    }
  }
  if (event.type === 'turn_result') inFlight.done(inFlight.text.join(' '))
})

async function ask(prompt: string, attachmentIds: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the turn')), 120_000)
    inFlight = {
      text: [],
      done: (text) => {
        clearTimeout(timer)
        inFlight = null
        resolve(text)
      },
    }
    handle.send(prompt, attachmentIds)
  })
}

let failures = 0
for (const testCase of cases) {
  process.stdout.write(`\n${testCase.kind.padEnd(6)} ${testCase.name} (${testCase.data.length} bytes) ... `)
  try {
    const attachment = await client.uploadAttachment(session.id, {
      name: testCase.name,
      mediaType: testCase.mediaType,
      data: testCase.data,
    })
    const answer = await ask(testCase.prompt, [attachment.id])
    const hit = testCase.expect.some((word) => answer.toLowerCase().includes(word))
    if (hit) {
      console.log(`✅  "${answer.trim().slice(0, 60)}"`)
    } else {
      failures++
      console.log(`❌  expected one of [${testCase.expect.join(', ')}], got: "${answer.trim().slice(0, 200)}"`)
    }
  } catch (error) {
    failures++
    console.log(`❌  ${error instanceof Error ? error.message : String(error)}`)
  }
}

handle.closeSession()
await server.close()

console.log('')
if (failures > 0) {
  console.error(`❌ ${failures} of ${cases.length} attachment kinds did not reach the model.\n`)
  process.exit(1)
}
console.log(`✅ All ${cases.length} attachment kinds reached the model.\n`)
process.exit(0)
