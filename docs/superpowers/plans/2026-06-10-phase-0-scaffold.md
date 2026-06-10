# Phase 0 Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable skeleton: Cloudflare Worker (Hono) serving a React/Vite hello page via Workers Static Assets, with live D1 + R2 bindings proven by a `/api/health` endpoint.

**Architecture:** Single Worker project at repo root. API routes under `/api/*` handled by Hono; everything else falls through to static assets built from `web/` (SPA fallback). D1 database `webex_migration` and R2 bucket `webex-migration-uploads` are real Cloudflare resources bound in `wrangler.jsonc`. Tests run the actual Worker against local D1/R2 emulation via `@cloudflare/vitest-pool-workers`.

**Tech Stack:** TypeScript, Hono 4, Wrangler 4, Vitest 3 + vitest-pool-workers, React 19, Vite.

**Environment notes for the engineer:**
- Windows / PowerShell. Run commands from the repo root `C:\cloudflare_projects\webex` unless stated.
- Cloudflare credentials live in `.env` (untracked). Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the process environment. Load them in any shell that talks to the Cloudflare API:

```powershell
Get-Content .env | Where-Object { $_ -match '^CLOUDFLARE_' } | ForEach-Object { $k,$v = $_ -split '=',2; Set-Item "env:$k" $v.Trim() }
```

- Never commit `.env`. It is already in `.gitignore`.

---

### Task 1: Worker package scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wrangler.jsonc`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "webex-migration",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "dev:web": "npm --prefix web run dev",
    "build": "npm --prefix web run build",
    "test": "vitest run",
    "deploy": "npm run build && wrangler deploy"
  },
  "dependencies": {
    "hono": "^4.7.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250101.0",
    "typescript": "~5.8.0",
    "vitest": "~3.2.0",
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `wrangler.jsonc`** (the `database_id` placeholder is filled in Task 2)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "webex-migration",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "webex_migration",
      "database_id": "REPLACE_IN_TASK_2"
    }
  ],
  "r2_buckets": [
    {
      "binding": "UPLOADS",
      "bucket_name": "webex-migration-uploads"
    }
  ]
}
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: completes without errors; `node_modules/` created (gitignored).

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json tsconfig.json wrangler.jsonc
git commit -m "chore: scaffold Worker package (hono, wrangler, vitest)"
```

---

### Task 2: Create D1 database and R2 bucket on Cloudflare

**Files:**
- Modify: `wrangler.jsonc` (fill `database_id`)

- [ ] **Step 1: Load Cloudflare credentials into the shell** (snippet from the header)

- [ ] **Step 2: Create the D1 database**

Run: `npx wrangler d1 create webex_migration`
Expected: success output containing a `database_id` UUID. Copy it.
If it already exists, run `npx wrangler d1 list` and copy the existing UUID instead.

- [ ] **Step 3: Create the R2 bucket**

Run: `npx wrangler r2 bucket create webex-migration-uploads`
Expected: "Created bucket" (or "already exists" — both fine).

- [ ] **Step 4: Fill the `database_id`**

In `wrangler.jsonc`, replace `REPLACE_IN_TASK_2` with the UUID from Step 2.

- [ ] **Step 5: Commit**

```powershell
git add wrangler.jsonc
git commit -m "chore: bind real D1 database and R2 bucket"
```

---

### Task 3: Health endpoint (TDD)

**Files:**
- Create: `vitest.config.ts`
- Create: `test/health.test.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Create `vitest.config.ts`**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.jsonc" } },
    },
  },
});
```

- [ ] **Step 2: Write the failing test `test/health.test.ts`**

```ts
import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("GET /api/health reports ok with working D1 and R2 bindings", async () => {
  const res = await SELF.fetch("http://example.com/api/health");
  expect(res.status).toBe(200);
  const body = await res.json<{ ok: boolean; d1: boolean; r2: boolean; time: string }>();
  expect(body.ok).toBe(true);
  expect(body.d1).toBe(true);
  expect(body.r2).toBe(true);
  expect(typeof body.time).toBe("string");
});

it("unknown /api route returns 404", async () => {
  const res = await SELF.fetch("http://example.com/api/nope");
  expect(res.status).toBe(404);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `src/index.ts` does not exist yet (module resolution error).

- [ ] **Step 4: Write `src/index.ts`**

```ts
import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  UPLOADS: R2Bucket;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/api/health", async (c) => {
  let d1 = false;
  let r2 = false;
  try {
    const row = await c.env.DB.prepare("SELECT 1 AS one").first<{ one: number }>();
    d1 = row?.one === 1;
  } catch {
    d1 = false;
  }
  try {
    await c.env.UPLOADS.list({ limit: 1 });
    r2 = true;
  } catch {
    r2 = false;
  }
  const ok = d1 && r2;
  return c.json({ ok, d1, r2, time: new Date().toISOString() }, ok ? 200 : 503);
});

export default app;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS (2 tests). Local emulated D1/R2 are provisioned automatically by vitest-pool-workers from `wrangler.jsonc`.

- [ ] **Step 6: Commit**

```powershell
git add vitest.config.ts test/health.test.ts src/index.ts
git commit -m "feat: /api/health endpoint exercising D1 and R2 bindings"
```

---

### Task 4: React hello page

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "webex-migration-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^4.5.0",
    "typescript": "~5.8.0",
    "vite": "^6.3.0"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`** (dev proxy sends `/api` to `wrangler dev` on 8787)

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
```

- [ ] **Step 4: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Webex Migration Tool</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 6: Create `web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";

type Health = { ok: boolean; d1: boolean; r2: boolean; time: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui", margin: "4rem auto", maxWidth: 480 }}>
      <h1>Webex Migration Tool</h1>
      <p>CUCM / Unity Connection → Webex Calling</p>
      {error && <p style={{ color: "crimson" }}>Health check failed: {error}</p>}
      {!health && !error && <p>Checking health…</p>}
      {health && (
        <ul style={{ listStyle: "none", padding: 0 }}>
          <li>Worker: {health.ok ? "✅ ok" : "❌ degraded"}</li>
          <li>D1: {health.d1 ? "✅ connected" : "❌ unavailable"}</li>
          <li>R2: {health.r2 ? "✅ connected" : "❌ unavailable"}</li>
          <li>Server time: {health.time}</li>
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 7: Install and build**

Run: `npm --prefix web install` then `npm --prefix web run build`
Expected: Vite build succeeds; `web/dist/index.html` exists.

- [ ] **Step 8: Commit**

```powershell
git add web
git commit -m "feat: React hello page showing /api/health status"
```

---

### Task 5: Serve frontend from the Worker (static assets)

**Files:**
- Modify: `wrangler.jsonc` (add `assets` block)

- [ ] **Step 1: Add the `assets` block to `wrangler.jsonc`** (after `"compatibility_date"`)

```jsonc
  "assets": {
    "directory": "web/dist",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
```

- [ ] **Step 2: Re-run unit tests** (config changed; ensure nothing broke)

Run: `npm test`
Expected: PASS (2 tests).

- [ ] **Step 3: Verify locally with `wrangler dev`**

Run in background: `npx wrangler dev`
Then: `Invoke-RestMethod http://localhost:8787/api/health` → expect `ok=True, d1=True, r2=True`
Then: `(Invoke-WebRequest http://localhost:8787/).Content` → expect HTML containing `Webex Migration Tool`
Stop the dev server afterwards.

- [ ] **Step 4: Commit**

```powershell
git add wrangler.jsonc
git commit -m "feat: serve built frontend via Workers Static Assets"
```

---

### Task 6: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

````markdown
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
npm run dev          # wrangler dev on http://localhost:8787
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
````

- [ ] **Step 2: Commit**

```powershell
git add README.md
git commit -m "docs: README with install / run / test / deploy"
```

---

### Task 7: Deploy and verify

**Files:** none (operational task)

- [ ] **Step 1: Load Cloudflare credentials into the shell** (snippet from the header)

- [ ] **Step 2: Deploy**

Run: `npm run deploy`
Expected: Vite build then `wrangler deploy` success, printing a `*.workers.dev` URL.

- [ ] **Step 3: Verify the deployed Worker**

Run: `Invoke-RestMethod https://<printed-url>/api/health`
Expected: `ok=True, d1=True, r2=True` (now against the real D1/R2).
Run: `(Invoke-WebRequest https://<printed-url>/).Content`
Expected: HTML containing `Webex Migration Tool`.

- [ ] **Step 4: Report the URL to Steven** — Phase 0 acceptance requires he sees it working before Phase 1 starts.
