# SPEC.md — Architecture & Migration Logic

## 1. Purpose

Move telephony configuration from on-prem Cisco CUCM + Unity Connection to
Webex Calling with minimal manual re-keying, full visibility of what will
change, and a safe push mechanism.

## 2. High-level flow

```
[CUCM/Unity exports]            [Webex org]
        |                            ^
        v                            |
  1. INGEST  →  2. PARSE  →  3. MAP  →  4. VALIDATE (dry run)  →  5. PUSH
        |            |           |              |                    |
       R2           D1          D1         Webex read APIs      Webex write APIs
                                                                 (via Queue)
```

Each migration project moves through these stages. The UI is a stage-based
wizard with a persistent left-hand summary of object counts and status
(parsed / mapped / validated / pushed / failed).

## 3. Data ingestion

### v1 — file upload
- **CUCM:** Bulk Administration (BAT) export CSVs / TAR. Expected object
  types: End Users, Phones, Directory Numbers (lines), Hunt Pilots, Hunt
  Lists, Line Groups, Call Pickup Groups, Translation Patterns (report-only),
  Device Pools and Locations (used as hints for Webex Locations).
- **Unity Connection:** user/mailbox export CSV plus greeting WAV files.
  **Known risk:** Unity does not export greetings to file natively in a
  single step — customers typically need COBRAS or a CUPI download script.
  v1 accepts a folder/zip of WAVs named by alias/extension; document the
  extraction procedure for Steven in the README. Resolve naming convention
  with Steven before building the parser.
- Uploads go straight to R2 (streamed, multipart for large zips). A
  `source_snapshots` row records what was uploaded and its parse status.

### Later phase — live connectors
- **CUCM AXL** (SOAP) and **Unity CUPI** (REST). Workers cannot reach
  on-prem systems directly; the design assumption is the customer exposes
  these via a Cloudflare Tunnel, or the connector phase ships a small
  on-prem collector script that pulls config and uploads it to the same
  ingest endpoint (preferred — keeps the Worker architecture unchanged).
  Decide with Steven when the phase starts.

## 4. Data model (D1)

Core tables (columns indicative, refine in migrations):

- `projects` — id, name, customer, webex_org_id, status, created_at
- `source_snapshots` — id, project_id, type (cucm|unity), r2_keys, parsed_at
- `src_users`, `src_phones`, `src_lines`, `src_hunt_pilots`,
  `src_hunt_members`, `src_pickup_groups`, `src_vm_boxes`,
  `src_vm_greetings` — normalised parsed source objects, each with
  `raw_json` of the original row for audit
- `mappings` — id, project_id, src_type, src_id, target_type, target_payload
  (JSON), status (auto|edited|excluded|invalid), notes
- `batches` — id, project_id, name, status
- `batch_items` — batch_id, mapping_id, validate_result, push_status,
  webex_resource_id, error_text, rollback_info
- `webex_tokens` — project_id, encrypted access/refresh tokens, scopes,
  expiry

## 5. Mapping rules (CUCM/Unity → Webex Calling)

These are the conceptual translations. The mapping engine produces a Webex
payload per source object plus a confidence/status flag. Anything it cannot
map cleanly is flagged for manual review in the UI — never silently dropped.

| Source object | Webex target | Notes |
|---|---|---|
| CUCM End User + primary DN | Person (Webex Calling licence) + assigned number | Match on email where possible; flag users with no email |
| Directory Number | Phone number / extension assignment | Requires numbers to already exist in the Webex location's number inventory — dry run checks this |
| Device Pool / CUCM Location | Webex Location | Mapping is suggested, human-confirmed; locations must pre-exist in Control Hub (report missing ones, do not create automatically in v1) |
| Phone (7800/8800 etc.) | Device assignment (or Workspace for common-area) | MAC-based onboarding where the model is Webex-supported; unsupported models go to an exceptions report |
| Hunt Pilot + Hunt List + Line Groups | Webex Hunt Group | Flatten CUCM's three-tier model into one hunt group; map distribution algorithm (top-down→regular, circular→circular, longest-idle→uniform, broadcast→simultaneous); flag multi-line-group pilots for review |
| Call Pickup Group | Call Pickup | Direct equivalent |
| Translation Patterns / Route Patterns | **Report only** in v1 | Dial-plan migration is out of scope to automate; produce a readable report so the engineer handles it in Control Hub |
| Unity mailbox | Person voicemail settings (enable, PIN reset flag, notification email) | |
| Unity greetings (WAV) | Voicemail greeting upload per person | Webex supports uploading greeting audio per person — verify current endpoint and accepted audio format; if format conversion is required, flag the files rather than transcode inside the Worker in v1 |

## 6. Webex integration

- OAuth Integration with admin scopes (people read/write, telephony config
  read/write, etc. — confirm exact current scope names on
  developer.webex.com when building Phase 4).
- All writes go through a single `webexClient` module: handles auth refresh,
  429/Retry-After, retries with backoff, and logs every request/response
  summary against the batch item.
- Dry run uses read APIs: does the email already exist as a person? Is the
  number in inventory and unassigned? Does the target location exist? Is a
  Calling licence available? Results render as a per-item traffic-light
  report (green = will push, amber = will push with caveat, red = blocked).

## 7. Push mechanics

1. User selects mapped items into a batch and runs validation.
2. Push enqueues one message per item (or small group) onto a Cloudflare
   Queue.
3. The queue consumer pushes in dependency order: Locations check → People →
   numbers → devices → hunt groups/pickup (members must exist first) →
   voicemail settings → greeting uploads.
4. Every success records the Webex resource ID; every failure records the
   error verbatim plus a plain-English explanation.
5. A batch can be re-run safely (idempotent: existing webex_resource_id →
   skip or PATCH).
6. Rollback: "undo batch" deletes/unassigns what the batch created, in
   reverse order, using the recorded IDs. Rollback never touches objects the
   batch did not create.

## 8. Reports

- **Pre-migration readiness report** (after parse): object counts, unmapped
  items, unsupported devices, users without email, numbers not in Webex
  inventory.
- **Dry-run report** per batch.
- **Post-push report** per batch: created/updated/failed with links to
  Control Hub where practical.
- All reports exportable as CSV (customer deliverable for Sword engagements).

## 9. Out of scope for v1

Live AXL/CUPI connectors, dial-plan/route-pattern automation, auto-creating
Webex Locations, CUCM features without clean Webex equivalents (CTI route
points, complex call-handler trees in Unity — call handlers get a report
listing them, not a migration).