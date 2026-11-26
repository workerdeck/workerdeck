import { describe, expect, it } from 'vitest'
import { renderLoginPage } from '../src/auth/login-page.ts'
import { dashboardCsp } from '../src/lib/static.ts'

function runPairScript(hash: string): { submitted: string | null; url: string } {
  const html = renderLoginPage({ action: '/auth/login', field: 'secret' })
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
  const state = { submitted: null as string | null, url: `/${hash}`, value: '' }
  const input = {
    get value() {
      return state.value
    },
    set value(v: string) {
      state.value = v
    },
  }
  const form = { submit: () => (state.submitted = state.value) }
  const location = { hash, pathname: '/', search: '' }
  const history = { replaceState: (_s: unknown, _t: string, url: string) => (state.url = url) }
  const document = { querySelector: () => form, getElementById: () => input }
  new Function('location', 'history', 'document', script)(location, history, document)
  return { submitted: state.submitted, url: state.url }
}

describe('login page pairing fragment', () => {
  it('strips #pair= from the address bar before submitting the key', () => {
    expect(runPairScript('#pair=abc%2Bdef123456')).toEqual({ submitted: 'abc+def123456', url: '/' })
  })

  it('leaves any other fragment alone', () => {
    expect(runPairScript('#/sessions')).toEqual({ submitted: null, url: '/#/sessions' })
  })

  it('is admitted by the CSP hash of the served document', () => {
    const html = renderLoginPage({ action: '/auth/login', field: 'secret' })
    expect(dashboardCsp(html)).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-/)
  })
})
