#!/usr/bin/env node
import { RelayUsageError, RELAY_HELP, runRelayCli } from './command.ts'

runRelayCli(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `workerdeck-relay: ${error instanceof Error ? error.message : String(error)}${error instanceof RelayUsageError ? `\n\n${RELAY_HELP}` : ''}`,
    )
    process.exit(error instanceof RelayUsageError ? 2 : 1)
  },
)
