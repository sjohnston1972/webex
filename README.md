# webexmigrate — CUCM → Webex Calling migration tool

Pulls telephony configuration from on-prem Cisco CUCM (live via AXL, or BAT
CSV uploads), lets you review and choose what to migrate, dry-runs every
object against the target Webex org, then pushes in dependency order with
full rollback. See `spec.md` (architecture), `roadmap.md` (phases) and
`docs/superpowers/specs/` (design records).

**Live at:** https://webex-migration.clydeford.net

Runs entirely on Cloudflare:

| Piece | Service |
|---|---|
| API (Hono) + React dashboard | Workers + Static Assets |
| Projects, parsed config, mappings, batches | D1 |
| Uploaded export files | R2 |
| Push jobs (ordered, retried) | Queues (`webex-push`) |

## Migration flow

1. **Source** — configure AXL (URL, credentials) and pull users, phones,
   lines, hunt pilots/lists/line groups and pickup groups straight from
   CUCM; or upload BAT/Unity CSV exports. Raw rows are kept for audit.
2. **Review & select** — the mapping engine builds a Webex payload per
   object (people, hunt groups, call pickup) with traffic-light readiness
   and notes. Tick what migrates; set the target Webex location.
3. **Webex** — OAuth (admin scopes) against the target org; tokens are
   AES-256-GCM encrypted in D1 and auto-refreshed.
4. **Validate & push** — batch the selection, dry-run it (person exists?
   number in inventory? location exists? licence available?), then push.
   People are pushed before groups; re-runs are idempotent; rollback
   deletes exactly what the batch created, in reverse order.
5. **Reports** — readiness / dry-run / post-push CSVs.

### Re-ingesting source data

The two ingest paths replace at different granularities, on purpose:

- **AXL / CUPI pull** — replaces *everything* previously pulled from that
  system. A pull is a full estate dump, so a second pull is the new truth.
- **Upload + parse** — replaces only the rows from *that snapshot*. Parsing the
  same snapshot twice is idempotent (double-click, retry, or a resumed partial
  parse all leave the same rows). Uploads stay additive **across** snapshots
  because one upload is usually one file: uploading `phones.csv` after
  `users.csv` must not wipe the users.

Consequence to be aware of: re-uploading a **corrected** CSV creates a *new*
snapshot, so the superseded rows from the earlier upload stay in `src_*`
alongside the corrected ones. There is no per-snapshot delete yet — until there
is, correct a bad upload before parsing it, or start the project again.

## CUCM reachability (AXL)

CUCM serves AXL at `https://<host>:8443/axl/`. Workers can only make
outbound requests on ports 80/443, so expose AXL through a **Cloudflare
Tunnel**:

```yaml
# cloudflared config on a host that can reach CUCM
ingress:
  - hostname: cucm-axl.example.com
    service: https://<cucm-ip>:8443
    originRequest:
      noTLSVerify: true   # CUCM self-signed cert
  - service: http_status:404
```

Then use `https://cucm-axl.example.com` as the AXL base URL in the app.
The AXL user needs the **Standard AXL API Access** role.

## Prerequisites

- Node.js 20+
- `.env` in the repo root (untracked) containing:

```
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
WEBEX_CLIENT_ID=...        # Webex integration (developer.webex.com)
WEBEX_SECRET=...
WEBEX_REDIRECT_URL=https://<your-domain>/auth/callback
ENC_KEY=...                # 32-byte base64 — encrypts tokens/credentials
```

Worker secrets (`ENC_KEY`, `WEBEX_SECRET`) are pushed with
`npx wrangler secret put <NAME>`; public config (`WEBEX_CLIENT_ID`,
`WEBEX_REDIRECT_URL`) lives in `wrangler.jsonc` vars. For local dev the
same values go in `.dev.vars` (also untracked) with a localhost redirect.

The Webex integration must include the admin scopes in
`src/webex/client.ts` (`REQUESTED_SCOPES`) and list the redirect URI(s).
Authorise with an **org admin** account.

## Install / run / test

```powershell
npm install
npm --prefix web install

npm test             # vitest inside the Workers runtime (emulated D1/R2)

npm run build        # vite build → web/dist
npm run dev          # wrangler dev on http://127.0.0.1:8787 (local D1/R2)
npm run dev:web      # optional: Vite hot reload on :5173, /api proxied

# D1 schema changes:
npx wrangler d1 migrations apply webex_migration --local
npx wrangler d1 migrations apply webex_migration --remote
```

## Deploy

```powershell
Get-Content .env | Where-Object { $_ -match '^CLOUDFLARE_' } | ForEach-Object { $k,$v = $_ -split '=',2; Set-Item "env:$k" $v.Trim() }
npm run deploy
```

Deploys to the custom domain `webex-migration.clydeford.net`. The app has
no built-in login — put **Cloudflare Access** in front of the hostname
before loading real customer data.

## Out of scope (v1)

Dial-plan/route-pattern automation (report only), auto-creating Webex
locations, device onboarding, Unity greeting WAV upload (mailboxes are
parsed and drive the voicemail-enable flag), CTI route points, Unity call
handler trees.
