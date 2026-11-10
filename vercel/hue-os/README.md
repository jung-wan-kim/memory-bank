# Hue OS Vercel Bridge

This is a shareable Vercel frontend for Hue OS, a Q&A-only personal mirror chat. It must not present itself as a coding agent, deployment runner, git status checker, or task executor.

Important: Vercel cannot reach a private `localhost` on your Mac. To keep using local Claude/Codex subscription CLIs, run the Hue OS local server on your machine and expose **only its Hue OS public listener** through a controlled HTTPS tunnel or reverse proxy. Then set that public origin on Vercel.

## Local server

```bash
PORT=3847 HUE_OS_PUBLIC_PORT=3848 REPLACEMENT_OS_ACCESS_PASSWORD=<your password> node ../../ui/server.cjs
# Listening on 127.0.0.1:3847 (this machine only)
# Hue OS public listener on 127.0.0.1:3848 (chat routes only — point the tunnel here, never at the dashboard port)
```

The same process runs two listeners:

| Port | Serves | Tunnel |
|------|--------|--------|
| `PORT` (3847) | The Memory Bank dashboard: every indexed conversation, tool input and fact, with no login | **Never.** It answers local same-origin requests only and refuses proxied ones (403), but a tunnel that hides its headers would hand your whole conversation history to the internet |
| `HUE_OS_PUBLIC_PORT` (3848) | `/hue-os` and `/api/hue-os/*` · `/api/replacement-os/*` only — no dashboard page or conversation API exists on this port | Yes — this one |

Expose port 3848 with your preferred tunnel, for example Cloudflare Tunnel, Tailscale Funnel, ngrok, or a reverse proxy (`cloudflared tunnel --url http://127.0.0.1:3848`). The public origin is that tunnel, e.g. `https://your-tunnel.example`.

`REPLACEMENT_OS_ACCESS_PASSWORD` has no default: without it the public listener does not start and the Hue OS login is off. The login UI takes 4 digits; logins are refused after 5 wrong passwords per client address per minute or 30 overall per 10 minutes. A 4-digit password is 10,000 values — that limit slows guessing, it does not stop it, so treat the tunnel URL as a secret too and take the tunnel down when you are not sharing.

## Vercel env

Set:

```bash
HUE_OS_LOCAL_ORIGIN=https://your-public-local-server-origin
```

The Vercel frontend calls `/api/hue-os/login`, `/api/hue-os/profile`, and `/api/hue-os/chat`. Those functions proxy to `${HUE_OS_LOCAL_ORIGIN}/api/replacement-os/*` while forwarding `x-forwarded-for` so the local server can enforce IP-based daily quota.

The deployed Vercel app does **not** run Claude or Codex itself. It only forwards requests to your local Hue OS server, so the actual Claude/Codex subscription login remains on your Mac terminal.

## Deploy

Official Vercel CLI flow: link, set env, preview deploy, verify, then production deploy.

```bash
cd vercel/hue-os
vercel link
vercel env add HUE_OS_LOCAL_ORIGIN production
vercel deploy
# after preview verification only:
vercel deploy --prod
```

Hue OS should refuse access/security-sensitive questions: passwords, tokens, cookies, env values, server/tunnel URLs, auth or quota bypasses, and security-weakening instructions.

Do not deploy to production until the tunnel URL, 4-digit auto-login password flow, quota, and local server are verified — and until `curl https://your-tunnel.example/api/search` answers 404 (the tunnel reaches the Hue OS listener, not the dashboard).
