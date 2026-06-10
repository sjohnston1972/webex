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

/** (Re)generate mappings for a project. Preserves rows the user edited or deselected. */
export async function generateMappings(env: Env, projectId: string): Promise<{ generated: number }> {
  const users = (await env.DB.prepare("SELECT * FROM src_users WHERE project_id = ?").bind(projectId).all<SrcUser>()).results;
  const vmBoxes = (await env.DB.prepare("SELECT alias, extension FROM src_vm_boxes WHERE project_id = ?").bind(projectId).all<SrcVmBox>()).results;
  const pilots = (await env.DB.prepare("SELECT * FROM src_hunt_pilots WHERE project_id = ?").bind(projectId).all<SrcHuntPilot>()).results;
  const pickups = (await env.DB.prepare("SELECT * FROM src_pickup_groups WHERE project_id = ?").bind(projectId).all<SrcPickup>()).results;

  const usersByExtension = new Map<string, SrcUser>();
  for (const u of users) if (u.primary_extension) usersByExtension.set(u.primary_extension, u);

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
  const upsert = (srcType: string, srcId: string, targetType: string, payload: unknown, confidence: string, notes: string[]) => {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mappings (id, project_id, src_type, src_id, target_type, target_payload, status, confidence, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'auto', ?, ?)
         ON CONFLICT(project_id, src_type, src_id) DO UPDATE SET
           target_payload = CASE WHEN mappings.status = 'auto' THEN excluded.target_payload ELSE mappings.target_payload END,
           confidence = CASE WHEN mappings.status = 'auto' THEN excluded.confidence ELSE mappings.confidence END,
           notes = CASE WHEN mappings.status = 'auto' THEN excluded.notes ELSE mappings.notes END`,
      ).bind(uuid(), projectId, srcType, srcId, targetType, JSON.stringify(payload), confidence, notes.join("\n") || null),
    );
  };

  for (const user of users) {
    const { payload, confidence, notes } = buildPersonMapping(user, vmBoxes);
    upsert("user", user.id, "person", payload, confidence, notes);
  }
  for (const pilot of pilots) {
    const { payload, confidence, notes } = buildHuntGroupMapping(pilot, membersByPilot.get(pilot.pattern) ?? [], usersByExtension);
    upsert("hunt_pilot", pilot.id, "hunt_group", payload, confidence, notes);
  }
  for (const group of pickups) {
    const { payload, confidence, notes } = buildPickupMapping(group, usersByExtension);
    upsert("pickup_group", group.id, "call_pickup", payload, confidence, notes);
  }

  await batchAll(env.DB, stmts);
  return { generated: stmts.length };
}
