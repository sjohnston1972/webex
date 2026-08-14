import type { Env } from "../env";

// Brute-force throttle for the PIN gate. State lives in D1, not memory: Workers
// isolates are recycled constantly, so an in-memory counter resets far faster
// than an attacker gives up.
//
// Two keys are tracked per attempt:
//   ip:<addr>  — 5 failures per window, then exponential lockout up to an hour.
//   global     — 20 failures per window, then a short lockout, capped low on
//                purpose: it catches distributed guessing across many IPs, but
//                a long global lock would let anyone deny the operator access.

const WINDOW_MS = 15 * 60 * 1000;

type Rule = { key: string; threshold: number; baseLockMs: number; maxLockMs: number };

type AttemptRow = { key: string; fails: number; window_start: string; locked_until: string | null; lockouts: number };

function rulesFor(ip: string | undefined): Rule[] {
  return [
    { key: `ip:${ip ?? "unknown"}`, threshold: 5, baseLockMs: 60_000, maxLockMs: 60 * 60_000 },
    { key: "global", threshold: 20, baseLockMs: 60_000, maxLockMs: 15 * 60_000 },
  ];
}

async function readRows(env: Env, rules: Rule[]): Promise<Map<string, AttemptRow>> {
  const placeholders = rules.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM pin_attempts WHERE key IN (${placeholders})`)
    .bind(...rules.map((r) => r.key))
    .all<AttemptRow>();
  return new Map(results.map((r) => [r.key, r]));
}

/**
 * How long the caller must wait, in seconds, before another PIN attempt counts.
 * 0 means "not locked". Checked before comparing the PIN, so a correct guess
 * during a lockout is rejected too — otherwise the lockout would only slow an
 * attacker down until the moment they got it right.
 */
export async function pinLockoutSeconds(env: Env, ip: string | undefined): Promise<number> {
  const rows = await readRows(env, rulesFor(ip));
  const now = Date.now();
  let until = 0;
  for (const row of rows.values()) {
    const t = row.locked_until ? Date.parse(row.locked_until) : 0;
    if (t > until) until = t;
  }
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

/** Record one wrong PIN against every throttle key, locking out past the threshold. */
export async function recordPinFailure(env: Env, ip: string | undefined): Promise<void> {
  const rules = rulesFor(ip);
  const rows = await readRows(env, rules);
  const now = Date.now();

  for (const rule of rules) {
    const row = rows.get(rule.key);
    // A stale window means the earlier failures have aged out; start counting again.
    const fresh = row && now - Date.parse(row.window_start) < WINDOW_MS;
    const fails = (fresh ? row!.fails : 0) + 1;
    const windowStart = fresh ? row!.window_start : new Date(now).toISOString();

    if (fails >= rule.threshold) {
      const lockouts = (row?.lockouts ?? 0) + 1;
      const lockMs = Math.min(rule.maxLockMs, rule.baseLockMs * 2 ** (lockouts - 1));
      const lockedUntil = new Date(now + lockMs).toISOString();
      console.error(`PIN lockout: key=${rule.key} lockout #${lockouts} for ${Math.round(lockMs / 1000)}s`);
      await upsert(env, { key: rule.key, fails: 0, window_start: new Date(now).toISOString(), locked_until: lockedUntil, lockouts });
    } else {
      await upsert(env, { key: rule.key, fails, window_start: windowStart, locked_until: null, lockouts: row?.lockouts ?? 0 });
    }
  }
}

/** A correct PIN clears the counters, so ordinary fat-fingering never accumulates. */
export async function clearPinFailures(env: Env, ip: string | undefined): Promise<void> {
  const rules = rulesFor(ip);
  const placeholders = rules.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM pin_attempts WHERE key IN (${placeholders})`)
    .bind(...rules.map((r) => r.key))
    .run();
}

async function upsert(env: Env, row: AttemptRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pin_attempts (key, fails, window_start, locked_until, lockouts) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, window_start = excluded.window_start,
       locked_until = excluded.locked_until, lockouts = excluded.lockouts`,
  )
    .bind(row.key, row.fails, row.window_start, row.locked_until, row.lockouts)
    .run();
}
