#!/usr/bin/env node
import { writeFileSync } from 'node:fs'

function out(text) {
  process.stdout.write(text)
}

function right(text) {
  return text.replaceAll(' ', '\x1b[1C')
}

if (process.env.FAKE_ENV_OUT) {
  writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ args: process.argv.slice(2), env: process.env }))
}
const url = 'https://claude.ai/oauth/authorize?code=true&client_id=fake&scope=user%3Ainference&state=abc'
out(right("Browser didn't open? Use the url below") + '\x1b[2;1H')
out(`\x1b]8;;${url}\x07${url}\x1b]8;;\x07`)
out('\x1b[4;1H' + right('Paste code here if prompted >') + ' ')
process.stdin.setRawMode?.(true)
let typed = ''
process.stdin.on('data', (chunk) => {
  const text = chunk.toString()
  if (text.length > 1 && text.endsWith('\r')) {
    typed += text.slice(0, -1)
    return
  }
  if (text !== '\r') {
    typed += text
    return
  }
  if (typed === 'good#abc') {
    out('\x1b[6;1H' + right('Long-lived authentication token created successfully!') + '\x1b[7;1H')
    out(right('Your OAuth token (valid for 1 year): ') + '\x1b[32msk-ant-oat01-FAKE_token-123\x1b[39m\r\n')
    setTimeout(() => process.exit(0), 50)
  } else {
    out('\x1b[6;1HOAuth error: Request failed with status code 400\r\n' + right('Press Enter to retry.'))
    typed = ''
  }
})
