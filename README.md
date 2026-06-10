# Webex Migration Tool

Migrates telephony configuration from on-prem Cisco CUCM + Unity Connection
to Webex Calling. See `spec.md` (architecture) and `roadmap.md` (phases).

Runs on Cloudflare: Workers (Hono API + React frontend via static assets),
D1 (relational data), R2 (uploaded exports), Queues (push, later phase).

## Prerequisites

- Node.js 20+
- A Cloudflare account; `.env` in the repo root (untracked) containing:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
```

## Install

```powershell
npm install
npm --prefix web install
```

## Run locally

Two options:

**Worker only (serves the built frontend):**

```powershell
npm run build        # builds web/ → web/dist
npm run dev          # wrangler dev on http://127.0.0.1:8787
```

**Frontend hot reload (two terminals):**

```powershell
npm run dev          # terminal 1: API on :8787
npm run dev:web      # terminal 2: Vite on :5173, /api proxied to :8787
```

D1 and R2 are emulated locally by wrangler; no cloud resources are touched
by `wrangler dev`.

## Test

```powershell
npm test
```

Runs Vitest inside the Workers runtime with emulated D1/R2.

## Deploy

```powershell
# load Cloudflare credentials from .env into this shell
Get-Content .env | Where-Object { $_ -match '^CLOUDFLARE_' } | ForEach-Object { $k,$v = $_ -split '=',2; Set-Item "env:$k" $v.Trim() }

npm run deploy
```

Builds the frontend and deploys the Worker (with `web/dist` as static
assets) to your Cloudflare account. Authentication in front of the app is
expected to be provided by Cloudflare Access — the app has no login.
