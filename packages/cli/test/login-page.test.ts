import { describe, expect, it } from 'vitest'
import { renderLoginPage } from '../src/auth/login-page.ts'
import { dashboardCsp } from '../src/lib/static.ts'

function runPairScript(hash: string): { submitted: string | null; url: string; button: string } {
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
  const button = { disabled: false, textContent: 'Sign in' }
  const form = { submit: () => (state.submitted = state.value), querySelector: () => button }
  const location = { hash, pathname: '/', search: '' }
  const history = { replaceState: (_s: unknown, _t: string, url: string) => (state.url = url) }
  const document = { querySelector: () => form, getElementById: () => input }
  new Function('location', 'history', 'document', script)(location, history, document)
  return { submitted: state.submitted, url: state.url, button: button.textContent }
}

describe('login page pairing fragment', () => {
  it('strips #pair= from the address bar and shows the sign-in in progress before submitting the key', () => {
    expect(runPairScript('#pair=abc%2Bdef123456')).toEqual({ submitted: 'abc+def123456', url: '/', button: 'Signing in…' })
  })

  it('leaves any other fragment alone', () => {
    expect(runPairScript('#/sessions')).toEqual({ submitted: null, url: '/#/sessions', button: 'Sign in' })
  })

  it('is admitted by the CSP hash of the served document', () => {
    const html = renderLoginPage({ action: '/auth/login', field: 'secret' })
    expect(dashboardCsp(html)).toMatch(/script-src 'self' 'wasm-unsafe-eval' 'sha256-/)
  })
})
