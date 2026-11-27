---
title: Remote access
description: Use the gateway on your computer from your phone, laptop or another editor over Tailscale or your own proxy, with a pairing link.
order: 14
---

Agents run where the code is; every other device is a screen. Remote mode publishes a gateway to
your [Tailscale](https://tailscale.com) tailnet, and a pairing link lets a phone, a browser or
another editor in. Nothing is exposed to the internet, and there is no service of ours to run.

## Before you start

- Tailscale installed and signed in on the computer and on every device you want to use.
- **HTTPS certificates** turned on for your tailnet (Tailscale admin console, DNS page). The CLI
  says so when they are off.
- Tailscale 1.104 or newer on the computer that runs the gateway.

## From VS Code

Run **WorkerDeck Host: Enable Remote Access**. It checks Tailscale, restarts the server in remote
mode (it asks first when sessions are busy), publishes it, and shows a QR code. Scan it with the
phone's camera: the dashboard opens and signs in. **Pair a Device** shows the code again;
**Disable Remote Access** takes the route down.

## From a terminal

```bash
npx workerdeck --remote
npx workerdeck remote enable
npx workerdeck pair-link
```

`--remote` (config `remote: true`, env `WORKERDECK_REMOTE=1`) binds loopback, always requires the
key (generated into `<state-dir>/auth-key` when you set none) and trusts the `tailscale serve`
proxy in front of it. It refuses to start combined with `--insecure`, `allowUnauthenticated` or a
non-loopback `--host`.

`remote enable` checks that the running gateway is in remote mode and refuses a request without
the key, then runs `tailscale serve` on port 443, or on the next free port when 443 already serves
something else (it never replaces a route it did not make). `remote status` shows the state,
`remote disable` removes the route. All three take `--port` and `--state-dir` when the gateway does
not run on the defaults.

## Behind another proxy, tunnel or VPN

Tailscale is the default, not a requirement. Set the address your devices reach the gateway at and
pairing uses it instead of a `tailscale serve` route:

```bash
npx workerdeck --remote --public-url https://deck.example.com
npx workerdeck pair-link
```

`--public-url` (config `publicUrl`, env `WORKERDECK_PUBLIC_URL`) takes an http(s) address with an
optional path prefix. `pair-link` uses it (or its own `--public-url`), the banner prints it, and its
origin is accepted on browser requests, so a proxy that rewrites `Host` still lets the dashboard
sign in. With a proxy on the same computer (Caddy, nginx, cloudflared), keep `--remote`: loopback,
key required, proxy headers trusted. For a VPN that reaches the computer directly, run the gateway
on that interface with `--host` and a key instead. In VS Code, set `workerdeck.host.publicUrl`:
**Enable Remote Access** then leaves Tailscale alone and goes straight to the QR code.

## The pairing link

```
https://home.tail1234.ts.net/#pair=<key>
```

The key sits in the fragment, which a browser never sends, so no server or proxy log sees it. The
dashboard's login page trades it for a session cookie and removes it from the address bar. VS
Code's **Add Gateway**, the dashboard's gateway form and the iOS and Android apps accept the same
link pasted into the address field and fill in the key.

The link is the gateway's key: anyone who has it can run agents on that computer. Share it only
with your own devices, and rotate the key (delete `<state-dir>/auth-key` and restart) if it leaks.

## What to expect

- Closing VS Code or the phone keeps turns running.
- A reboot brings sessions back to resume, not the interrupted turn.
- Keep-awake blocks idle sleep, not a closed lid.
