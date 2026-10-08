#!/usr/bin/env node
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.CODEX_HOME
const marker = join(home, 'fake-login')
const [command, flag] = process.argv.slice(2)

if (process.env.FAKE_ENV_OUT) {
  writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({ args: process.argv.slice(2), env: process.env }))
}
if (command === 'logout') {
  const existed = existsSync(marker)
  rmSync(marker, { force: true })
  process.exit(existed ? 0 : 1)
}
if (command !== 'login' || flag !== '--device-auth') {
  process.exit(2)
}
process.stdout.write(
  '\nWelcome to Codex [v\x1b[90m0.161.0\x1b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n' +
    '1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n' +
    '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mKUIE-STXVW\x1b[0m\n\n',
)
const timer = setInterval(() => {
  if (existsSync(join(home, 'approve'))) {
    writeFileSync(marker, 'ok')
    process.stdout.write('Successfully logged in\n')
    process.exit(0)
  }
  if (existsSync(join(home, 'deny'))) {
    process.stderr.write('Error logging in with device code\n')
    process.exit(1)
  }
}, 50)
timer.unref?.()
setTimeout(() => process.exit(3), 60_000)
