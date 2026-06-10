# v1 Full Build — Design

Date: 2026-06-10. Steven authorized autonomous build of the entire v1 with
two scope changes from the original spec:

1. **AXL live pull is now a v1 ingestion path** (was "later phase"). Users
   configure CUCM AXL credentials per project and pull config directly;
   CSV/BAT upload remains as the fallback path.
2. **UI is a Meraki-style dashboard**: light, clean, professional — white
   cards on a soft grey canvas, green accent, left nav, data tables with
   status pills. Explicitly not dark/cyber themed.

## AXL reachability constraint

CUCM serves AXL at `https://<host>:8443/axl/`. Cloudflare Workers outbound
`fetch` is only reliable to ports 80/443. Design: the AXL base URL is free
text; the "test connection" endpoint reports reachability truthfully. The
documented production pattern is a Cloudflare Tunnel (or any reverse proxy)
exposing CUCM 8443 on a 443 hostname, e.g. `https://cucm-axl.clydeford.net`.
Self-signed CUCM certs are handled by the tunnel (`noTLSVerify`), never by
the Worker.

## AXL pull scope (v1)

SOAP requests (Basic auth, `fast-xml-parser` for responses):
- `listUser` → src_users (userid, names, mail, dept, primary extension)
- `listPhone` → src_phones (name, model, description, owner)
- `listLine` → src_lines (pattern, partition, description)
- `listHuntPilot` + `listHuntList` + `listLineGroup` → src_hunt_pilots +
  src_hunt_members (flattened member DNs with order)
- `listCallPickupGroup` → src_pickup_groups

Each pull creates a `source_snapshots` row (`source='axl'`); re-pull replaces
that project's AXL-sourced rows (delete + insert, snapshot-scoped).

## Data model additions vs original spec

- `axl_connections` — project_id PK, base_url, username, password_enc,
  verified_at, cucm_version
- `mappings.selected` (0/1) — drives "choose features to migrate"
- Credentials and Webex tokens encrypted at rest with AES-GCM via WebCrypto;
  key is a Worker secret `ENC_KEY` (32-byte base64), never in git.

## Push transport

Try Cloudflare Queues (`webex-push` queue, consumer in same Worker). If the
account plan rejects queue creation, fall back to a D1-backed job table
drained by `waitUntil` loops + a 1-minute cron — same handler code either
way (roadmap anticipated this).

## Mapping & push order (unchanged from spec)

People → numbers/extensions → hunt groups → pickup → voicemail settings.
Devices and greeting upload remain post-v1; unsupported items go to reports,
nothing is silently dropped. Rollback deletes created resources in reverse
order using recorded Webex IDs only.

## UI structure

- `/` Projects (cards + create)
- `/projects/:id` Overview — stage progress, object counts, readiness
- `/projects/:id/source` — tabs: AXL pull | file upload; snapshot history
- `/projects/:id/review` — per-type tables, include/exclude checkboxes,
  mapping status pills, payload editor for flagged rows
- `/projects/:id/webex` — OAuth connect, org/licences/locations status
- `/projects/:id/push` — batch builder, traffic-light dry run, push
  progress, rollback
- `/projects/:id/reports` — CSV downloads

## Out of scope (unchanged)

Dial-plan automation, auto-creating Locations, CTI route points, Unity
call-handler trees, greeting transcoding, device onboarding (reported only).
