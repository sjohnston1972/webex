# Phase 0 — Scaffold: Design

Date: 2026-06-10. Approved by Steven in session.

Parent docs: `spec.md` (architecture), `roadmap.md` (phases). This design
covers only Phase 0.

## Goal

A deployable skeleton of the CUCM/Unity → Webex Calling migration tool:
Cloudflare Worker (Hono, TypeScript) serving a React/Vite frontend via
Workers Static Assets, with D1 and R2 bound. No business logic yet.

## Structure

```
/                  Worker project root (single npm package)
  wrangler.jsonc   Worker config: D1 + R2 bindings, static assets
  src/             Worker code (Hono app)
    index.ts       Entry: serves /api/* routes, assets fallback
  web/             React + Vite frontend (own package)
    src/           App with one "hello" page calling /api/health
  README.md        Install / run / deploy instructions
```

## Decisions

- **One Worker, one deploy.** Frontend built by Vite into `web/dist`,
  served by the Worker through the `assets` config (not a separate Pages
  project). API routes under `/api/*` take precedence; everything else
  falls through to static assets with SPA fallback.
- **Bindings:** D1 database `webex_migration` (binding `DB`), R2 bucket
  `webex-migration-uploads` (binding `UPLOADS`). Created with wrangler
  using the account in `.env`. No D1 schema yet — migrations start in
  Phase 1.
- **Health endpoint:** `GET /api/health` returns
  `{ ok, d1: boolean, r2: boolean, time }` — it exercises both bindings
  (trivial D1 query, R2 head/list) so a green health check proves the
  wiring.
- **No in-app auth.** Cloudflare Access is assumed in front (roadmap).
- **Secrets:** `.env` stays untracked (`.gitignore`); wrangler reads
  `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from the environment
  for deploys.

## Acceptance (from roadmap)

- `wrangler dev` runs locally serving the hello page and a passing
  health check.
- `wrangler deploy` publishes successfully.
- README documents install / run / deploy.

## Out of scope

Projects CRUD, uploads, parsing, Webex anything — Phase 1+.
