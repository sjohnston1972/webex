# ROADMAP.md — Build Phases

Work one phase at a time. A phase is done when its acceptance criteria pass
and Steven has seen it working. Do not start the next phase in the same
session without confirming.

## Phase 0 — Scaffold
Worker + Hono + React/Vite frontend deployed via `wrangler`. D1 and R2
bound. Cloudflare Access assumed in front (no in-app login). One health
endpoint, one "hello" page.
- ✅ `wrangler dev` runs locally; `wrangler deploy` works; README documents
  install / run / deploy.

## Phase 1 — Projects & ingestion
Create/list/delete migration projects. Upload CUCM export files and a Unity
zip to R2 against a project. Snapshot records in D1. Project delete purges
D1 + R2.
- ✅ Steven can create a project, upload a sample CUCM export, see it listed,
  and delete the project cleanly.

## Phase 2 — CUCM parsing + readiness report
Parsers for users, phones, lines, hunt pilots/lists/line groups, pickup
groups. Normalised rows in `src_*` tables with raw JSON retained. Readiness
report page with object counts and obvious problems (no email, unsupported
phone model).
- ✅ Parsing a real anonymised export produces correct counts that Steven can
  verify against CUCM; parser unit tests pass.

## Phase 3 — Unity parsing + greetings
Mailbox CSV parser; greeting WAV zip ingest into R2 keyed to mailboxes;
unmatched WAVs reported. Confirm naming convention with Steven first.
- ✅ Mailboxes appear linked to their greeting files; orphans are listed.

## Phase 4 — Webex connection + dry run
Webex OAuth integration flow per project (verify current scopes/endpoints on
developer.webex.com). Read-side checks: people by email, number inventory,
locations, licences. Mapping engine for users + numbers + locations with
manual review/edit UI. Traffic-light dry-run report.
- ✅ Against a Webex sandbox org, the dry run correctly identifies an
  existing person, a missing number, and a missing location.

## Phase 5 — Push: people & numbers
Queue-based push (or D1 job table + cron if Queues unavailable). Create
people, assign numbers/extensions, record Webex IDs, idempotent re-run,
rollback for the batch. Post-push report.
- ✅ A 10-user batch pushes into the sandbox, re-running creates no
  duplicates, and rollback removes exactly those 10.

## Phase 6 — Hunt groups, pickup, devices
Mapping + push for hunt groups (flattened model per SPEC), call pickup, and
supported device onboarding. Dependency ordering enforced (members before
groups).
- ✅ A hunt group with members pushes correctly and appears functional in
  Control Hub.

## Phase 7 — Voicemail
Enable/configure voicemail per person from Unity data; upload greetings
(verify endpoint + audio format first; flag rather than transcode
incompatible files).
- ✅ A migrated user has voicemail enabled with their original greeting
  audible.

## Phase 8 — Live connectors (post-v1)
On-prem collector script (preferred) or Tunnel-fronted AXL/CUPI pulls
feeding the existing ingest endpoint. Design discussion with Steven before
any code.

## Parked ideas
Dial-plan analysis assistant, Unity call-handler tree visualiser, multi-org
support for Sword customer engagements, scheduled delta sync before cutover.