// pnpm smoke:media [image|pdf|text] [--engine codex]   — spends tokens, never part of `pnpm test`.
//
// generated file → POST /sessions/:id/attachments → user_message(attachmentIds) → Runner → CLI → the model actually
// describing what it was shown. The fakes in `pnpm test` prove the server builds the right content blocks but not that
// the engine accepts them, and a CLI dropping non-text blocks looks exactly like a model ignoring the picture.
//
// The refusal is a case too, and both halves are read off `ENGINE_CAPABILITIES[engine].attachments` rather than a
// hard-coded engine name: a kind the record forswears must be refused with 415 and a message naming the engine, and
// one it claims must reach the model — so a record change needs no edit here.
//
// The files are generated, not committed, so the repo carries no binaries and the magic words cannot leak into the
// prompt.
import { deflateSync } from 'node:zlib'
import WebSocket from 'ws'
import { WorkerDeckClient } from '@workerdeck/client'
import { createWorkerServer } from '@workerdeck/server'
import { ENGINE_CAPABILITIES, type SessionEvent } from '@workerdeck/protocol'

// CRC-32, the PNG/zlib one.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1
  }
  return c >>> 0
})

const crc32 = (buf: Buffer): number => {
  let c = 0xff_ff_ff_ff
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xff_ff_ff_ff) >>> 0
}

const pngChunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

// A solid-colour RGB PNG, `size`×`size`.
const solidPng = (size: number, [r, g, b]: [number, number, number]): Buffer => {
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

// A one-page PDF showing `text`. Offsets are computed as the objects are laid out — a hand-guessed xref is the usual
// reason a minimal PDF is rejected.
const onePagePdf = (text: string): Buffer => {
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
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

type Case = {
  kind: string
  name: string
  mediaType: string
  data: Buffer
  prompt: string
  // The answer must contain one of these, case-insensitively.
  expect: string[]
}

const CASES: Case[] = [
  {
    kind: 'image',
    name: 'swatch.png',
    mediaType: 'image/png',
    data: solidPng(64, [220, 30, 30]),
    prompt: 'Look at the attached image. Reply with exactly one word: the colour that fills it. No tools, no preamble.',
    expect: ['red', 'crimson', 'scarlet'],
  },
  {
    kind: 'pdf',
    name: 'memo.pdf',
    mediaType: 'application/pdf',
    data: onePagePdf('VELVET ANTELOPE'),
    prompt: 'Read the attached PDF and reply with exactly the two words printed on its only page. No tools, no preamble.',
    expect: ['velvet antelope'],
  },
  {
    kind: 'text',
    name: 'notes.txt',
    mediaType: 'text/plain',
    data: Buffer.from('The passphrase is BRASS LANTERN.\n', 'utf8'),
    prompt: 'The attached file names a passphrase. Reply with exactly that passphrase. No tools, no preamble.',
    expect: ['brass lantern'],
  },
]

const argv = process.argv.slice(2)
const engineFlag = argv.indexOf('--engine')
const ENGINE = engineFlag === -1 ? 'claude' : (argv[engineFlag + 1] ?? '')
if (!(ENGINE in ENGINE_CAPABILITIES)) {
  console.error(`Unknown engine '${ENGINE}'. Use one of: ${Object.keys(ENGINE_CAPABILITIES).join(', ')}`)
  process.exit(1)
}
const only = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--engine')
const cases = only ? CASES.filter((c) => c.kind === only) : CASES
if (cases.length === 0) {
  console.error(`Unknown case '${only}'. Use one of: ${CASES.map((c) => c.kind).join(', ')}`)
  process.exit(1)
}

const ACCEPTED: readonly string[] = ENGINE_CAPABILITIES[ENGINE as 'claude'].attachments

// A single declared profile is implicit on create, so the codex leg sends no profile name — but the profile must
// exist: the engine is a property of it, not of the request.
const server = createWorkerServer({
  allowUnauthenticated: true,
  allowedCwdRoots: ['/tmp'],
  ...(ENGINE === 'claude' ? {} : { profiles: [{ name: ENGINE, engine: ENGINE as 'codex' }] }),
})
const { port } = await server.listen(0, '127.0.0.1')
const client = new WorkerDeckClient({
  baseUrl: `http://127.0.0.1:${port}/v1`,
  WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
})

console.log(`\nAttachment smoke — real ${ENGINE} engine on 127.0.0.1:${port}`)
console.log(`accepts: ${ACCEPTED.join(', ')}`)
console.log('='.repeat(60))

const session = await client.createSession({
  cwd: '/tmp',
  // The cheap model of each lineup — this smoke tests the wire, not the model.
  ...(ENGINE === 'codex' ? { model: 'gpt-5.6-luna' } : {}),
})
const handle = client.attach(session.id)

let inFlight: { text: string[]; done: (text: string) => void } | null = null
handle.on('event', (event: SessionEvent) => {
  if (!inFlight) {
    return
  }
  if (event.type === 'assistant_message') {
    const content = event.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          inFlight.text.push(String((block as { text: string }).text))
        }
      }
    } else if (typeof content === 'string') {
      inFlight.text.push(content)
    }
  }
  if (event.type === 'turn_result') {
    inFlight.done(inFlight.text.join(' '))
  }
})

const ask = async (prompt: string, attachmentIds: string[]): Promise<string> => {
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

// Raw `fetch` rather than `client.uploadAttachment`, which throws the status away — and the status is half the claim:
// 415 says "wrong kind", 400/500 says the route failed to cope.
const expectRefused = async (testCase: Case): Promise<string | null> => {
  const url = `http://127.0.0.1:${port}/v1/sessions/${session.id}/attachments?name=${encodeURIComponent(testCase.name)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': testCase.mediaType },
    body: new Uint8Array(testCase.data),
  })
  const payload = (await res.json().catch(() => ({}))) as { error?: string }
  if (res.status !== 415) {
    return `expected 415, got ${res.status} (${payload.error ?? 'no message'})`
  }
  // The remedy is only actionable if it says which engine refused.
  if (!payload.error?.includes(ENGINE)) {
    return `415 but the message does not name the engine: "${payload.error ?? ''}"`
  }
  return null
}

let failures = 0
for (const testCase of cases) {
  const refuses = !ACCEPTED.includes(testCase.kind)
  process.stdout.write(
    `\n${testCase.kind.padEnd(6)} ${testCase.name} (${testCase.data.length} bytes) ` + `${refuses ? '— expected refusal ' : ''}... `,
  )
  try {
    if (refuses) {
      const problem = await expectRefused(testCase)
      if (problem) {
        failures++
        console.log(`❌  ${problem}`)
      } else {
        console.log(`✅  415, refused by name`)
      }
      continue
    }
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
  console.error(`❌ ${failures} of ${cases.length} attachment kinds behaved wrongly on ${ENGINE}.\n`)
  process.exit(1)
}
console.log(`✅ All ${cases.length} attachment kinds behaved as ${ENGINE}'s record claims.\n`)
process.exit(0)
