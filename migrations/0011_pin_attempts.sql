-- Brute-force protection for the PIN gate. One row per throttle key: a
-- per-IP key and a coarse global key, so a distributed guessing attempt is
-- caught even when no single IP crosses its own threshold.
CREATE TABLE pin_attempts (
  key TEXT PRIMARY KEY,            -- 'ip:<addr>' | 'global'
  fails INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL,      -- ISO; failures older than the window don't count
  locked_until TEXT,               -- ISO; NULL when not locked
  lockouts INTEGER NOT NULL DEFAULT 0  -- consecutive lockouts, drives exponential backoff
);
