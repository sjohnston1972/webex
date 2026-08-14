export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Run D1 statements in chunks (D1 batch has statement limits on large sets). */
export async function batchAll(db: D1Database, stmts: D1PreparedStatement[], chunkSize = 50): Promise<void> {
  for (let i = 0; i < stmts.length; i += chunkSize) {
    await db.batch(stmts.slice(i, i + chunkSize));
  }
}

/** Parse a JSON payload column, returning a fallback instead of throwing so one
 * malformed/NULL row can't 500 an entire report or listing endpoint. */
export function safeJsonParse<T = any>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  // Formula/CSV injection: a cell that Excel/Sheets would evaluate as a formula
  // (leading = + - @, tab or CR) is neutralised with a leading apostrophe so a
  // CUCM object named e.g. =HYPERLINK(...) can't execute in a delivered report.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return lines.join("\r\n") + "\r\n";
}
