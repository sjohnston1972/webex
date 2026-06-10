# Full End-to-End Migration Report

**Project:** dCloud Lab (Cisco dCloud London) → Webex org `sj-sandbox`
**Date:** 2026-06-10 · **Batch:** "Full migration" (`2e01bf02-847d-41cd-a584-7057415a7672`)
**Tool:** webexmigrate @ https://webex-migration.clydeford.net

---

## Executive summary

| | |
|---|---|
| Items eligible & attempted | **121** |
| Migrated successfully | **94 (78%)** |
| Failed | **27** — all environmental: 23 licence capacity, 4 email domains owned by another org |
| Infrastructure success rate | **100%** — every hunt group, route pattern, translation pattern, pickup group, workspace and call park migrated |
| Wall-clock push time | ~4 minutes across three passes (queue concurrency 6) |

Every failure carries the verbatim Webex API error on its batch item; nothing
was silently dropped. The batch is idempotent (re-push skips completed items)
and fully rollback-capable (only objects this batch created would be removed).

## Source environment (pulled live)

- **CUCM 15.0.1.12900(234)** via AXL over Cloudflare Tunnel: 75 users,
  300 phones, 144 directory numbers, 7 hunt pilots (17 members), 2 pickup
  groups, 7 translation patterns, full route plan report (200 patterns) +
  25 dial-plan infrastructure objects.
- **Unity Connection 15.0.1.86** via CUPI: 78 mailboxes, 22 recorded
  greetings downloaded (WAV) and matched to mailboxes.
- Site mapping: device pool `dCloud_DP` → Webex location **London HQ**.

## Eligibility (126 mappings generated)

Selected: 74 people, 29 route patterns, 7 hunt groups, 5 workspaces,
2 pickup groups, 3 translation patterns, 1 call park (edited from range
`72[1-4]X` to a single extension — blocked→fixed flow).

Excluded as blocked (5): 1 person without a usable email; 4 translation
patterns with no Webex-expressible transformation (prefix-digit patterns,
`*+` syntax, X wildcards in the destination) — all listed in the readiness
report with reasons.

**Dry run:** 88 green / 33 amber / 0 red.

## Results by object type

| Type | Done | Failed | Notes |
|---|---|---|---|
| People | 47 | 27 | incl. voicemail enablement and 9 real Unity greetings uploaded (0 audio failures); 4 created without a number (shared lines / no DN) |
| Hunt groups | 7 | 0 | flattened CUCM pilot→list→line-group model; policies mapped (Top Down→REGULAR etc.) |
| Route patterns | 29 | 0 | as dial patterns in Webex dial plan **“CUCM via LGW-London”** (premises PSTN, registering Local Gateway trunk) |
| Workspaces | 5 | 0 | owner-less/common-area phones, first line as the number |
| Translation patterns | 3 | 0 | unique-name + idempotent matching-pattern lookup |
| Call pickup | 2 | 0 | members without calling automatically dropped with a note (Webex error 4470) |
| Call park | 1 | 0 | as a Webex call park extension |

## Failures (27) — all environmental

1. **23 × licence capacity** — `No Webex Calling licence with available units —
   org seat capacity exhausted`. The sandbox holds **30 Webex Calling
   Professional seats** (it tolerated ~47 assignments before hard-stopping;
   consumption now reads 30/30). The tool fails these fast and verbatim;
   in a real engagement this is a procurement line item, not a tool action.
2. **4 × email domain conflicts** — `POST /people → 409` for
   `mbot/sbot/cms-scheduler/cuacap@dcloud.cisco.com`. Webex refuses to create
   people whose email domain is claimed by another org (Cisco's own, for these
   dCloud demo identities). Undetectable in a dry run — Webex offers no
   cross-org email availability API.

## Issues found and fixed during this run

| Issue | Root cause | Fix (deployed + committed) |
|---|---|---|
| Push throughput | queue concurrency 1 → hours for 121 items | consumer concurrency → 6 (~4 min total) |
| Licence/location errors retried 3× each | thrown as generic errors | classified permanent (422), fail fast |
| 23 people 409 on creation | **shared lines**: multiple CUCM users carry the same primary extension | engine de-duplicates extensions at mapping time; push falls back to numberless person creation on number conflicts, with an explicit note |
| 8 people 400 `Phone number or Extension is required` | Webex rejects calling users with no number | users without a DN are created as plain people (no calling licence) + note |
| 3 translation patterns 409 `name already exists` | CUCM descriptions aren't unique (3 × “dCloud CER ELIN TP”) | names suffixed with the pattern; creation is idempotent by matching pattern |
| 2 pickup groups 400 `Error 4470 user not available` | members without calling can't join pickup | offending member dropped automatically, group created, note appended |
| 13 people `Location "null"` on re-push | my process error: regenerating mappings reset the bulk location for site-less users | location re-applied; noted that bulk overrides post-date regeneration |

## Webex end state

- Licences: Calling Professional **30/30**, Workspaces 5/30.
- Dial plan **“CUCM via LGW-London”** with 29 patterns routed to trunk `LGW-London`.
- 3 org translation patterns, 7 hunt groups, 2 pickup groups, 1 park extension
  at London HQ, 5 workspaces, 47 people (9 with their original Unity greeting
  as the no-answer greeting).
- Rollback: available per batch — deletes exactly what this batch created,
  in reverse dependency order.

## Recommendations

1. **Licences:** size the target org before cutover — readiness shows 74
   calling users vs 30 seats.
2. **Domains:** dCloud system identities (`@dcloud.cisco.com` bots) should be
   excluded from migration scope; real customers should verify their domain in
   Control Hub first.
3. **Shared lines:** 23 users share extensions in CUCM. Webex has no shared-line
   parity for this pattern — review whether these should be workspaces, virtual
   lines, or single owners (the tool now flags them at mapping time).
4. Dial-plan digit manipulation (4 blocked TPs) needs manual Control Hub design,
   as scoped.
