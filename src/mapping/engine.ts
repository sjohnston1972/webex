import type { Env } from "../env";
import { batchAll, uuid } from "../lib/util";

// CUCM line-group algorithm → Webex hunt group policy
export function mapHuntPolicy(cucmAlgorithm: string | null): { policy: string; note?: string } {
  switch ((cucmAlgorithm ?? "").trim().toLowerCase()) {
    case "top down":
      return { policy: "REGULAR" };
    case "circular":
      return { policy: "CIRCULAR" };
    case "longest idle time":
      return { policy: "UNIFORM" };
    case "broadcast":
      return { policy: "SIMULTANEOUS" };
    default:
      return { policy: "REGULAR", note: `Unknown CUCM algorithm "${cucmAlgorithm ?? ""}" — defaulted to REGULAR` };
  }
}

export type PersonPayload = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  extension: string | null;
  phoneNumber: string | null; // E.164 if the source DN looks like one
  locationName: string | null;
  voicemail: boolean;
};

type SrcUser = {
  id: string;
  userid: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  primary_extension: string | null;
};

type SrcVmBox = { alias: string; extension: string | null };

type SrcHuntPilot = {
  id: string;
  pattern: string;
  description: string | null;
  algorithm: string | null;
  raw_json: string;
};

type SrcPickup = { id: string; name: string; pattern: string | null; members_json: string | null };

type SrcTransPattern = {
  id: string;
  pattern: string;
  partition_name: string | null;
  description: string | null;
  called_party_mask: string | null;
  prefix_digits: string | null;
};

/**
 * CUCM translation pattern → Webex translation pattern (Call Routing).
 * Digit-manipulation semantics never map 1:1, so these are always flagged
 * for engineer review and default to deselected.
 */
export function buildTranslationPatternMapping(tp: SrcTransPattern, knownExtensions: Set<string>) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "amber";

  const mask = tp.called_party_mask?.trim() || null;
  const prefix = tp.prefix_digits?.trim() || null;

  let replacementPattern: string | null = null;
  if (mask) {
    replacementPattern = mask;
    notes.push("Derived from CUCM called-party transformation mask — verify wildcard semantics match Webex replacement syntax");
    if (knownExtensions.has(mask)) {
      notes.push(`Mask resolves to internal extension ${mask} — if this is a DID alias, assigning the number to the person in Webex may replace this pattern entirely`);
    }
  } else if (prefix) {
    confidence = "red";
    notes.push(`CUCM prefixes digits ("${prefix}") rather than masking — no direct Webex equivalent derived; configure manually in Control Hub`);
  } else {
    confidence = "red";
    notes.push("No transformation mask or prefix on the CUCM pattern — review its purpose; likely dial-plan routing, which stays manual in v1");
  }

  const payload = {
    name: tp.description?.trim() || `TP ${tp.pattern}`,
    matchingPattern: tp.pattern,
    replacementPattern,
    cucmPartition: tp.partition_name,
    cucmPrefixDigits: prefix,
  };
  return { payload, confidence, notes };
}

export function buildPersonMapping(user: SrcUser, vmBoxes: SrcVmBox[]) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "green";

  const email = user.email?.trim() || null;
  if (!email) {
    confidence = "red";
    notes.push("No email address — Webex requires an email to create a person");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    confidence = "red";
    notes.push(`"${email}" does not look like a valid email`);
  }

  const ext = user.primary_extension?.trim() || null;
  if (!ext) {
    if (confidence === "green") confidence = "amber";
    notes.push("No primary extension — person will be created without a number");
  }
  const phoneNumber = ext && /^\+\d{7,15}$/.test(ext) ? ext : null;

  const hasVm = vmBoxes.some((b) => (ext && b.extension === ext) || b.alias.toLowerCase() === user.userid.toLowerCase());

  const payload: PersonPayload = {
    email,
    firstName: user.first_name,
    lastName: user.last_name,
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.userid,
    extension: phoneNumber ? null : ext,
    phoneNumber,
    locationName: null,
    voicemail: hasVm,
  };
  return { payload, confidence, notes };
}

export function buildHuntGroupMapping(
  pilot: SrcHuntPilot,
  memberDns: string[],
  usersByExtension: Map<string, SrcUser>,
) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "green";

  const { policy, note } = mapHuntPolicy(pilot.algorithm);
  if (note) {
    confidence = "amber";
    notes.push(note);
  }
  let multiGroup = false;
  try {
    multiGroup = JSON.parse(pilot.raw_json)?.multiLineGroup === true;
  } catch {
    /* raw_json is trusted JSON from our own ingest; ignore parse issues */
  }
  if (multiGroup) {
    confidence = "amber";
    notes.push("CUCM hunt list had multiple line groups — flattened into one Webex hunt group, review member order");
  }

  const agentEmails: string[] = [];
  const unresolved: string[] = [];
  for (const dn of memberDns) {
    const user = usersByExtension.get(dn);
    if (user?.email) agentEmails.push(user.email);
    else unresolved.push(dn);
  }
  if (unresolved.length > 0) {
    confidence = "amber";
    notes.push(`${unresolved.length} member DN(s) did not resolve to a user with email: ${unresolved.join(", ")}`);
  }
  if (memberDns.length === 0) {
    confidence = "amber";
    notes.push("No members found for this hunt pilot");
  }

  const payload = {
    name: pilot.description?.trim() || `Hunt ${pilot.pattern}`,
    extension: pilot.pattern,
    policy,
    agentEmails,
    unresolvedMembers: unresolved,
    locationName: null as string | null,
  };
  return { payload, confidence, notes };
}

export function buildPickupMapping(group: SrcPickup, usersByExtension: Map<string, SrcUser>) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "green";
  let memberDns: string[] = [];
  try {
    memberDns = JSON.parse(group.members_json ?? "[]");
  } catch {
    /* members_json written by our own ingest */
  }

  const agentEmails: string[] = [];
  const unresolved: string[] = [];
  for (const dn of memberDns) {
    const user = usersByExtension.get(dn);
    if (user?.email) agentEmails.push(user.email);
    else unresolved.push(dn);
  }
  if (unresolved.length > 0) {
    confidence = "amber";
    notes.push(`${unresolved.length} member DN(s) did not resolve: ${unresolved.join(", ")}`);
  }
  if (memberDns.length === 0) {
    confidence = "amber";
    notes.push("No members resolved for this pickup group");
  }

  const payload = {
    name: group.name,
    agentEmails,
    unresolvedMembers: unresolved,
    locationName: null as string | null,
  };
  return { payload, confidence, notes };
}

/** Most common non-null value, or null. */
function mostCommon(values: (string | null | undefined)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/** (Re)generate mappings for a project. Preserves rows the user edited or deselected. */
export async function generateMappings(env: Env, projectId: string): Promise<{ generated: number }> {
  const users = (await env.DB.prepare("SELECT * FROM src_users WHERE project_id = ?").bind(projectId).all<SrcUser>()).results;
  const vmBoxes = (await env.DB.prepare("SELECT alias, extension FROM src_vm_boxes WHERE project_id = ?").bind(projectId).all<SrcVmBox>()).results;
  const pilots = (await env.DB.prepare("SELECT * FROM src_hunt_pilots WHERE project_id = ?").bind(projectId).all<SrcHuntPilot>()).results;
  const pickups = (await env.DB.prepare("SELECT * FROM src_pickup_groups WHERE project_id = ?").bind(projectId).all<SrcPickup>()).results;
  const transPatterns = (await env.DB.prepare("SELECT * FROM src_trans_patterns WHERE project_id = ?").bind(projectId).all<SrcTransPattern>()).results;

  // Site context: a user's site is the device pool (fallback: CUCM location)
  // of their owned phone; the human-confirmed site → Webex location mapping
  // lives in site_mappings.
  const phones = (
    await env.DB.prepare("SELECT owner_userid, device_pool, location_name FROM src_phones WHERE project_id = ?")
      .bind(projectId)
      .all<{ owner_userid: string | null; device_pool: string | null; location_name: string | null }>()
  ).results;
  const siteByUser = new Map<string, string>();
  for (const p of phones) {
    const site = p.device_pool || p.location_name;
    if (p.owner_userid && site && !siteByUser.has(p.owner_userid.toLowerCase())) {
      siteByUser.set(p.owner_userid.toLowerCase(), site);
    }
  }
  const siteToLocation = new Map<string, string>();
  for (const row of (
    await env.DB.prepare("SELECT cucm_site, webex_location FROM site_mappings WHERE project_id = ?")
      .bind(projectId)
      .all<{ cucm_site: string; webex_location: string | null }>()
  ).results) {
    if (row.webex_location) siteToLocation.set(row.cucm_site, row.webex_location);
  }
  const siteOf = (userid: string | null | undefined) => (userid ? (siteByUser.get(userid.toLowerCase()) ?? null) : null);
  const locationFor = (site: string | null) => (site ? (siteToLocation.get(site) ?? null) : null);

  const usersByExtension = new Map<string, SrcUser>();
  for (const u of users) if (u.primary_extension) usersByExtension.set(u.primary_extension, u);

  const knownExtensions = new Set<string>(usersByExtension.keys());
  for (const l of (
    await env.DB.prepare("SELECT pattern FROM src_lines WHERE project_id = ?").bind(projectId).all<{ pattern: string }>()
  ).results) {
    knownExtensions.add(l.pattern);
  }

  const memberRows = (
    await env.DB.prepare(
      "SELECT hunt_pilot_pattern, member_dn FROM src_hunt_members WHERE project_id = ? ORDER BY position",
    )
      .bind(projectId)
      .all<{ hunt_pilot_pattern: string; member_dn: string }>()
  ).results;
  const membersByPilot = new Map<string, string[]>();
  for (const m of memberRows) {
    if (!membersByPilot.has(m.hunt_pilot_pattern)) membersByPilot.set(m.hunt_pilot_pattern, []);
    membersByPilot.get(m.hunt_pilot_pattern)!.push(m.member_dn);
  }

  const stmts: D1PreparedStatement[] = [];
  const upsert = (srcType: string, srcId: string, targetType: string, payload: unknown, confidence: string, notes: string[], selectedDefault = 1) => {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mappings (id, project_id, src_type, src_id, target_type, target_payload, status, selected, confidence, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?)
         ON CONFLICT(project_id, src_type, src_id) DO UPDATE SET
           target_payload = CASE WHEN mappings.status = 'auto' THEN excluded.target_payload ELSE mappings.target_payload END,
           confidence = CASE WHEN mappings.status = 'auto' THEN excluded.confidence ELSE mappings.confidence END,
           notes = CASE WHEN mappings.status = 'auto' THEN excluded.notes ELSE mappings.notes END`,
      ).bind(uuid(), projectId, srcType, srcId, targetType, JSON.stringify(payload), selectedDefault, confidence, notes.join("\n") || null),
    );
  };

  // The site of a group is the most common site among its resolved members.
  const memberSites = (dns: string[]) => mostCommon(dns.map((dn) => siteOf(usersByExtension.get(dn)?.userid)));

  for (const user of users) {
    const { payload, confidence, notes } = buildPersonMapping(user, vmBoxes);
    const site = siteOf(user.userid);
    upsert("user", user.id, "person", { ...payload, cucmSite: site, locationName: locationFor(site) }, confidence, notes);
  }
  for (const pilot of pilots) {
    const memberDns = membersByPilot.get(pilot.pattern) ?? [];
    const { payload, confidence, notes } = buildHuntGroupMapping(pilot, memberDns, usersByExtension);
    const site = memberSites(memberDns);
    upsert("hunt_pilot", pilot.id, "hunt_group", { ...payload, cucmSite: site, locationName: locationFor(site) }, confidence, notes);
  }
  for (const group of pickups) {
    const { payload, confidence, notes } = buildPickupMapping(group, usersByExtension);
    let memberDns: string[] = [];
    try {
      memberDns = JSON.parse(group.members_json ?? "[]");
    } catch {
      /* written by our own ingest */
    }
    const site = memberSites(memberDns);
    upsert("pickup_group", group.id, "call_pickup", { ...payload, cucmSite: site, locationName: locationFor(site) }, confidence, notes);
  }
  for (const tp of transPatterns) {
    const { payload, confidence, notes } = buildTranslationPatternMapping(tp, knownExtensions);
    // Deselected by default: digit manipulation always needs engineer review.
    upsert("trans_pattern", tp.id, "translation_pattern", payload, confidence, notes, 0);
  }

  await batchAll(env.DB, stmts);
  return { generated: stmts.length };
}
