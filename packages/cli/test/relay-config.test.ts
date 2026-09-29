import { describe, expect, it } from 'vitest'
import { parseArgs, resolveInstanceConfig } from '../src/config.ts'

describe('relay config', () => {
  const loaded = {
    path: '/x/workerdeck.config.mjs',
    options: { relay: { url: 'ws://relay:7777', gateway: 'mac', keyFile: '~/.workerdeck/relay.key' } },
  }

  it('passes the relay block through and lets WORKERDECK_RELAY_KEY supply the key', () => {
    const relay = resolveInstanceConfig(parseArgs([]), loaded, { WORKERDECK_RELAY_KEY: 'wdr_env' }).options.relay
    expect(relay).toMatchObject({ url: 'ws://relay:7777', gateway: 'mac', keyFile: '~/.workerdeck/relay.key', key: 'wdr_env' })
    expect(typeof relay?.log).toBe('function')
  })

  it('leaves the key to the key file when the env var is unset or empty', () => {
    expect(resolveInstanceConfig(parseArgs([]), loaded, { WORKERDECK_RELAY_KEY: '' }).options.relay?.key).toBeUndefined()
  })

  it('adds nothing when no relay is configured', () => {
    expect(resolveInstanceConfig(parseArgs([]), { path: null, options: {} }, {}).options.relay).toBeUndefined()
  })
})
