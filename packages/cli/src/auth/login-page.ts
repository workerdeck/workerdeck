/**
 * The login page is the CLI's, not the dashboard's. That split is deliberate:
 * the SPA ships prebuilt and is also served straight from vite in dev, so making
 * it aware of an auth scheme that only exists in the turnkey instance would
 * couple two things that are otherwise independent. An unauthenticated document
 * request gets this instead of index.html; nothing in the SPA changes.
 *
 * Self-contained by necessity — it renders before any bundled asset is worth
 * fetching, and it must not depend on the app it is gating.
 */

export type LoginPageOptions = {
  /** Where the form POSTs. Comes from the auth module, not hardcoded here. */
  action: string
  /** Form field name carrying the secret. */
  field: string
  /** Shown when a previous attempt failed. */
  error?: string
  /** Where to send the browser after a successful login. */
  redirectTo?: string
  /** Field name carrying the post-login redirect. */
  redirectField?: string
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

export function renderLoginPage(options: LoginPageOptions): string {
  const { action, field, error, redirectTo, redirectField } = options
  const hidden =
    redirectField && redirectTo
      ? `<input type="hidden" name="${escapeHtml(redirectField)}" value="${escapeHtml(redirectTo)}">`
      : ''
  const alert = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>workerdeck</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf9; --fg: #1c1917; --muted: #78716c;
    --card: #ffffff; --border: #e7e5e4; --accent: #c2410c; --error: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1917; --fg: #fafaf9; --muted: #a8a29e;
      --card: #292524; --border: #44403c; --accent: #fb923c; --error: #fca5a5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 1.5rem;
    background: var(--bg); color: var(--fg);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  form {
    width: 100%; max-width: 22rem; background: var(--card);
    border: 1px solid var(--border); border-radius: 12px; padding: 1.75rem;
  }
  h1 { margin: 0 0 .25rem; font-size: 1.05rem; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 1.25rem; color: var(--muted); font-size: .875rem; }
  label { display: block; font-size: .8125rem; font-weight: 500; margin-bottom: .375rem; }
  input[type=password] {
    width: 100%; padding: .5rem .625rem; font: inherit; color: inherit;
    background: var(--bg); border: 1px solid var(--border); border-radius: 7px;
  }
  input[type=password]:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    width: 100%; margin-top: 1rem; padding: .5rem .75rem; font: inherit; font-weight: 500;
    color: var(--bg); background: var(--fg); border: 0; border-radius: 7px; cursor: pointer;
  }
  button:hover { opacity: .9; }
  .error { margin: 0 0 1rem; color: var(--error); font-size: .8125rem; }
</style>
</head>
<body>
  <form method="post" action="${escapeHtml(action)}">
    <h1>workerdeck</h1>
    <p class="sub">This instance is protected. Enter its access key to continue.</p>
    ${alert}
    <label for="key">Access key</label>
    <input id="key" name="${escapeHtml(field)}" type="password" autocomplete="current-password"
           autofocus required spellcheck="false">
    ${hidden}
    <button type="submit">Sign in</button>
  </form>
</body>
</html>
`
}
