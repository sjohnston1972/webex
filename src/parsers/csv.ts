// RFC4180-ish CSV parsing plus header-driven detection of CUCM BAT / Unity exports.

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Strip BOM
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      // Only a quote at the START of a field opens a quoted field. A stray quote
      // mid-field (e.g. a description like `6" display`) is then a literal
      // character instead of swallowing the rest of the file into one field.
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

export type CsvKind = "users" | "phones" | "lines" | "vm_boxes" | "unknown";

type FieldSpec = Record<string, string[]>; // canonical field -> candidate header names (lowercased)

const USER_FIELDS: FieldSpec = {
  userid: ["user id", "userid", "user_id"],
  first_name: ["first name", "firstname"],
  last_name: ["last name", "lastname"],
  email: ["mail id", "mailid", "email", "email address", "directory uri"],
  department: ["department"],
  primary_extension: ["primary extension", "telephone number", "primary dn", "extension"],
};

const PHONE_FIELDS: FieldSpec = {
  device_name: ["device name", "name", "device"],
  description: ["description"],
  model: ["model", "device type", "phone type"],
  owner_userid: ["owner user id", "owner", "owner userid", "user id"],
  device_pool: ["device pool", "device pool name"],
  location_name: ["location", "location name"],
};

const LINE_FIELDS: FieldSpec = {
  pattern: ["directory number", "dn", "pattern", "dnorpattern"],
  partition_name: ["route partition", "partition", "route partition name"],
  description: ["description"],
};

const VM_FIELDS: FieldSpec = {
  alias: ["alias"],
  display_name: ["display name", "displayname"],
  extension: ["extension", "dtmfaccessid", "dtmf access id"],
  email: ["corporate email address", "email address", "email"],
};

function matchHeaders(headers: string[], spec: FieldSpec): Map<string, number> | null {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const map = new Map<string, number>();
  for (const [field, candidates] of Object.entries(spec)) {
    const idx = lower.findIndex((h) => candidates.includes(h));
    if (idx >= 0) map.set(field, idx);
  }
  return map.size > 0 ? map : null;
}

export function detectKind(headers: string[]): CsvKind {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const has = (names: string[]) => names.some((n) => lower.includes(n));
  // Phones first: a Phones export whose owner column is literally "User ID"
  // would otherwise be misdetected as a Users export (both specs list "user id").
  // A genuine Users export has no device+model columns, so this is unambiguous.
  if (has(PHONE_FIELDS.device_name) && has(PHONE_FIELDS.model)) return "phones";
  if (has(VM_FIELDS.alias)) return "vm_boxes";
  if (has(USER_FIELDS.userid)) return "users";
  if (has(LINE_FIELDS.pattern)) return "lines";
  return "unknown";
}

export type ParsedRow = { fields: Record<string, string | null>; raw: Record<string, string> };

export function parseExport(content: string): { kind: CsvKind; rows: ParsedRow[] } {
  const table = parseCsv(content);
  if (table.length < 1) return { kind: "unknown", rows: [] };
  const headers = table[0];
  const kind = detectKind(headers);
  if (kind === "unknown") return { kind, rows: [] };

  const spec = { users: USER_FIELDS, phones: PHONE_FIELDS, lines: LINE_FIELDS, vm_boxes: VM_FIELDS }[kind];
  const map = matchHeaders(headers, spec)!;

  const rows: ParsedRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => (raw[h] = cells[idx] ?? ""));
    const fields: Record<string, string | null> = {};
    for (const field of Object.keys(spec)) {
      const idx = map.get(field);
      const v = idx === undefined ? "" : (cells[idx] ?? "").trim();
      fields[field] = v === "" ? null : v;
    }
    rows.push({ fields, raw });
  }
  return { kind, rows };
}
