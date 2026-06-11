import type { Env } from "../env";
import { batchAll, uuid } from "../lib/util";

/**
 * Error-correct a CUCM pattern into Webex-acceptable syntax.
 * Separator/formatting characters (".", "\", "/", spaces, quotes) are
 * removed; anything left that Webex cannot express is reported so the
 * mapping can be flagged instead of silently pushed wrong.
 */
export function sanitizePattern(raw: string): { pattern: string; removed: string[]; unsupported: string[] } {
  const removed = [...new Set(raw.match(/[.\\/\s"']/g) ?? [])];
  const pattern = raw.replace(/[.\\/\s"']/g, "");
  // Webex dial patterns allow: digits, X wildcards, [] ranges with -, !, *, #, +
  const unsupported = [...new Set(pattern.match(/[^0-9Xx*#!+\[\]\-]/g) ?? [])];
  return { pattern, removed, unsupported };
}

/** Webex-specific translation pattern rules (learned from the live API/UI). */
export function checkTranslationPatternRules(matchingPattern: string | null, replacementPattern: string | null): string[] {
  const issues: string[] = [];
  if (matchingPattern?.includes("*+")) issues.push(`Webex rejects "*+" in translation patterns — found in matching pattern "${matchingPattern}"`);
  if (replacementPattern) {
    if (replacementPattern.includes("*+")) issues.push(`Webex rejects "*+" in translation patterns — found in destination "${replacementPattern}"`);
    if (/[Xx]/.test(replacementPattern)) issues.push(`Webex destination patterns cannot contain X wildcards — found in "${replacementPattern}"`);
  }
  return issues;
}

/**
 * Re-evaluate a mapping's payload after a user edit. Returns the new
 * confidence and notes — a real fix clears the block (shown as "fixed"),
 * a non-fix stays blocked with the reason.
 */
export function recheckMapping(targetType: string, payload: Record<string, any>): { confidence: "green" | "amber" | "red"; notes: string[] } {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "green";
  const blocked = (note: string) => {
    confidence = "red";
    notes.push(note);
  };
  const review = (note: string) => {
    if (confidence !== "red") confidence = "amber";
    notes.push(note);
  };

  const checkExtension = (value: unknown, label: string) => {
    if (value === null || value === undefined || value === "") return;
    if (!/^\d+$/.test(String(value))) blocked(`${label} "${value}" must be plain digits`);
  };

  if (targetType === "person") {
    if (!payload.email) blocked("No email address");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email))) blocked(`"${payload.email}" does not look like a valid email`);
    checkExtension(payload.extension, "Extension");
    if (payload.phoneNumber && !/^\+\d{7,15}$/.test(String(payload.phoneNumber))) blocked(`Phone number "${payload.phoneNumber}" must be E.164 (+44…)`);
  } else if (targetType === "workspace") {
    if (!payload.name) blocked("Workspace needs a name");
    checkExtension(payload.extension, "Extension");
    if (payload.phoneNumber && !/^\+\d{7,15}$/.test(String(payload.phoneNumber))) blocked(`Phone number "${payload.phoneNumber}" must be E.164`);
  } else if (targetType === "call_park") {
    if (!payload.extension) blocked("Needs a single park extension (plain digits)");
    else checkExtension(payload.extension, "Park extension");
  } else if (targetType === "hunt_group") {
    checkExtension(payload.extension, "Hunt group number");
    if ((payload.unresolvedMembers ?? []).length > 0) review(`${payload.unresolvedMembers.length} member(s) still unresolved`);
  } else if (targetType === "translation_pattern") {
    const issues = [
      ...sanitizePattern(String(payload.matchingPattern ?? "")).unsupported.map((c) => `Matching pattern contains unsupported "${c}"`),
      ...checkTranslationPatternRules(payload.matchingPattern ?? null, payload.replacementPattern ?? null),
    ];
    if (!payload.replacementPattern) blocked("No destination (replacement) pattern");
    issues.forEach(blocked);
    review("Verify matching/replacement semantics before pushing");
  } else if (targetType === "route_pattern") {
    const fixed = sanitizePattern(String(payload.dialPattern ?? ""));
    if (!payload.dialPattern) blocked("No dial pattern");
    fixed.unsupported.forEach((c) => blocked(`Dial pattern contains unsupported "${c}"`));
    review("Verify pattern; choose/confirm route target before pushing");
  }
  return { confidence, notes };
}

/** Extensions must end up as plain digits; separators are corrected away. */
export function sanitizeExtension(raw: string): { extension: string; removed: string[]; valid: boolean } {
  const removed = [...new Set(raw.match(/[.\\/\s"'-]/g) ?? [])];
  const extension = raw.replace(/[.\\/\s"'-]/g, "");
  return { extension, removed, valid: /^\d+$/.test(extension) };
}

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

type SrcVmBox = { alias: string; extension: string | null; greeting_key?: string | null };

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

/** What a translation pattern's destination resolves to in the CUCM route plan. */
export type DestinationInfo = {
  pattern: string;
  exists: boolean;
  entries: { type: string; partition: string | null }[];
  device?: { name: string; model: string | null; ownerName: string | null } | null;
};

/**
 * CUCM translation pattern → Webex translation pattern (Call Routing).
 * Digit-manipulation semantics never map 1:1, so these are always flagged
 * for engineer review and default to deselected. When destination info is
 * provided (resolved against the pulled route plan), a non-existent
 * destination blocks the mapping and an existing one is described in detail
 * (type, partition, carrying device) so the engineer doesn't have to
 * correlate manually.
 */
export function buildTranslationPatternMapping(tp: SrcTransPattern, knownExtensions: Set<string>, destination?: DestinationInfo | null) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "amber";

  const mask = tp.called_party_mask?.trim() || null;
  const prefix = tp.prefix_digits?.trim() || null;

  const matching = sanitizePattern(tp.pattern);
  if (matching.removed.length > 0) notes.push(`Matching pattern corrected: "${tp.pattern}" → "${matching.pattern}"`);
  if (matching.unsupported.length > 0) {
    confidence = "red";
    notes.push(`Matching pattern uses CUCM syntax Webex cannot express: ${matching.unsupported.join(" ")}`);
  }
  for (const issue of checkTranslationPatternRules(matching.pattern, null)) {
    confidence = "red";
    notes.push(issue);
  }

  let replacementPattern: string | null = null;
  if (mask) {
    const fixedMask = sanitizePattern(mask);
    replacementPattern = fixedMask.pattern;
    if (fixedMask.removed.length > 0) notes.push(`Replacement corrected: "${mask}" → "${fixedMask.pattern}"`);
    for (const issue of checkTranslationPatternRules(null, fixedMask.pattern)) {
      confidence = "red";
      notes.push(issue);
    }
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

  if (mask && destination) {
    if (!destination.exists) {
      confidence = "red";
      notes.push(`Destination ${destination.pattern} does not exist anywhere in the CUCM route plan — verify the target before migrating this pattern`);
    } else {
      const kinds = destination.entries
        .map((e) => `${e.type.replace(/_/g, " ")}${e.partition ? ` in partition ${e.partition}` : ""}`)
        .join("; ");
      let detail = `Destination ${destination.pattern}: ${kinds || "found in route plan"}`;
      if (destination.device) {
        detail += ` — on device ${destination.device.name}${destination.device.model ? ` (${destination.device.model}${destination.device.ownerName ? `, ${destination.device.ownerName}` : ""})` : ""}`;
      }
      notes.push(detail);
    }
  }

  const payload = {
    name: tp.description?.trim() || `TP ${tp.pattern}`,
    matchingPattern: matching.pattern,
    cucmPattern: tp.pattern,
    replacementPattern,
    cucmPartition: tp.partition_name,
    cucmPrefixDigits: prefix,
    destination: destination ?? null,
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

  let ext = user.primary_extension?.trim() || null;
  if (!ext) {
    if (confidence === "green") confidence = "amber";
    notes.push("No primary extension — person will be created without a number");
  }
  const phoneNumber = ext && /^\+\d{7,15}$/.test(ext) ? ext : null;
  if (ext && !phoneNumber) {
    const fixed = sanitizeExtension(ext);
    if (fixed.removed.length > 0) notes.push(`Extension corrected: "${ext}" → "${fixed.extension}" (removed ${fixed.removed.join(" ")})`);
    if (!fixed.valid) {
      confidence = "red";
      notes.push(`Extension "${fixed.extension}" is not a plain number — fix before pushing`);
    }
    ext = fixed.extension;
  }

  const vmBox = vmBoxes.find((b) => (ext && b.extension === ext) || b.alias.toLowerCase() === user.userid.toLowerCase());
  const hasVm = !!vmBox;
  if (vmBox?.greeting_key) notes.push("Unity greeting matched — uploaded as the no-answer greeting after voicemail is enabled");

  const payload: PersonPayload & { greetingKey?: string | null } = {
    email,
    firstName: user.first_name,
    lastName: user.last_name,
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.userid,
    extension: phoneNumber ? null : ext,
    phoneNumber,
    locationName: null,
    voicemail: hasVm,
    greetingKey: vmBox?.greeting_key ?? null,
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
  const agentDetails: { email: string; name: string; extension: string }[] = [];
  const unresolved: string[] = [];
  for (const dn of memberDns) {
    const user = usersByExtension.get(dn);
    if (user?.email) {
      agentEmails.push(user.email);
      agentDetails.push({ email: user.email, name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.userid, extension: dn });
    } else {
      unresolved.push(dn);
    }
  }
  if (unresolved.length > 0) {
    confidence = "amber";
    notes.push(`${unresolved.length} member DN(s) did not resolve to a user with email: ${unresolved.join(", ")}`);
  }
  if (memberDns.length === 0) {
    confidence = "amber";
    notes.push("No members found for this hunt pilot");
  }

  const fixed = sanitizeExtension(pilot.pattern);
  if (fixed.removed.length > 0) notes.push(`Hunt number corrected: "${pilot.pattern}" → "${fixed.extension}"`);
  if (!fixed.valid) {
    confidence = "red";
    notes.push(`Hunt pilot "${pilot.pattern}" contains wildcards/pattern syntax — a Webex hunt group needs a literal number`);
  }

  const payload = {
    name: pilot.description?.trim() || `Hunt ${pilot.pattern}`,
    extension: fixed.extension,
    policy,
    agentEmails,
    agentDetails,
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
  const agentDetails: { email: string; name: string; extension: string }[] = [];
  const unresolved: string[] = [];
  for (const dn of memberDns) {
    const user = usersByExtension.get(dn);
    if (user?.email) {
      agentEmails.push(user.email);
      agentDetails.push({ email: user.email, name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.userid, extension: dn });
    } else {
      unresolved.push(dn);
    }
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
    agentDetails,
    unresolvedMembers: unresolved,
    locationName: null as string | null,
  };
  return { payload, confidence, notes };
}

type SrcRoutePattern = { id: string; name: string; partition_name: string | null; description: string | null };

/**
 * CUCM call park number/range → Webex Call Park Extension.
 * CUCM ranges (e.g. 54XX) cannot push as one object — Webex park
 * extensions are literal numbers, so ranges are blocked with guidance.
 */
export function buildCallParkMapping(cp: SrcRoutePattern) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "green";

  const fixed = sanitizeExtension(cp.name);
  if (fixed.removed.length > 0) notes.push(`Park number corrected: "${cp.name}" → "${fixed.extension}"`);
  if (!fixed.valid) {
    confidence = "red";
    notes.push(
      `"${cp.name}" is a range/pattern — Webex call park extensions are single numbers. Edit this mapping to one number and add the rest as separate park extensions in Control Hub, or use location call park groups instead`,
    );
  }

  const payload = {
    name: cp.description?.trim() || `Park ${fixed.extension || cp.name}`,
    extension: fixed.valid ? fixed.extension : null,
    cucmPattern: cp.name,
    locationName: null as string | null,
    cucmSite: null as string | null,
  };
  return { payload, confidence, notes };
}

/**
 * CUCM route pattern → dial pattern in a Webex premises-PSTN dial plan.
 * The route target (trunk / route group) is chosen by the engineer on the
 * Review page; CUCM's "." separator is stripped (Webex has no pre-dot).
 */
export function buildRoutePatternMapping(rp: SrcRoutePattern) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "amber";

  const fixed = sanitizePattern(rp.name);
  const dialPattern = fixed.pattern;
  notes.push("Choose a route target (trunk or route group) — pushed as a dial pattern in a Webex dial plan (premises PSTN)");
  if (fixed.unsupported.length > 0) {
    confidence = "red";
    notes.push(`Pattern contains characters with no Webex dial-pattern equivalent (${fixed.unsupported.join(" ")}): review "${rp.name}"`);
  }
  if (fixed.removed.length > 0) {
    notes.push(`Pattern corrected (${rp.name} → ${dialPattern}, removed ${fixed.removed.join(" ")}) — confirm digit handling; Webex does not strip access codes`);
  }

  const payload = {
    name: rp.description?.trim() || `RP ${rp.name}`,
    cucmPattern: rp.name,
    dialPattern,
    cucmPartition: rp.partition_name,
    routeChoice: null as { type: string; id: string; name: string } | null,
  };
  return { payload, confidence, notes };
}

type SrcPhone = {
  id: string;
  device_name: string;
  description: string | null;
  model: string | null;
  owner_userid: string | null;
  device_pool: string | null;
  location_name: string | null;
  lines_json: string | null;
};

/**
 * Owner-less phone (common area) → Webex Workspace with calling.
 * First line becomes the workspace number; extra lines are flagged.
 */
export function buildWorkspaceMapping(phone: SrcPhone) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "green";

  let lines: string[] = [];
  try {
    lines = JSON.parse(phone.lines_json ?? "[]");
  } catch {
    /* written by our own ingest */
  }

  let extension: string | null = null;
  let phoneNumber: string | null = null;
  if (lines.length === 0) {
    confidence = "amber";
    notes.push("Phone has no lines — workspace will be created without a number");
  } else {
    const first = lines[0];
    if (/^\+\d{7,15}$/.test(first)) {
      phoneNumber = first;
    } else {
      const fixed = sanitizeExtension(first);
      if (fixed.removed.length > 0) notes.push(`Line corrected: "${first}" → "${fixed.extension}"`);
      if (!fixed.valid) {
        confidence = "red";
        notes.push(`Line "${first}" is not a plain number — fix before pushing`);
      }
      extension = fixed.extension;
    }
    if (lines.length > 1) {
      confidence = "amber";
      notes.push(`Phone has ${lines.length} lines — only the first (${lines[0]}) migrates; others: ${lines.slice(1).join(", ")}`);
    }
  }

  const payload = {
    name: phone.description?.trim() || phone.device_name,
    deviceName: phone.device_name,
    deviceModel: phone.model,
    extension,
    phoneNumber,
    locationName: null as string | null,
    cucmSite: null as string | null,
  };
  return { payload, confidence, notes };
}

/**
 * Directory numbers with no migration path: not a person's number, not a
 * workspace's number, not a hunt group number. Used by the summary tile and
 * the readiness report so nothing is silently dropped.
 */
export type UnattachedDn = { pattern: string; device: string | null; model: string | null; owner: string | null };

export async function listUnattachedDns(env: Env, projectId: string): Promise<UnattachedDn[]> {
  const lines = (
    await env.DB.prepare("SELECT pattern FROM src_lines WHERE project_id = ?").bind(projectId).all<{ pattern: string }>()
  ).results;
  const payloads = (
    await env.DB.prepare(
      "SELECT target_payload FROM mappings WHERE project_id = ? AND target_type IN ('person','workspace','hunt_group')",
    )
      .bind(projectId)
      .all<{ target_payload: string }>()
  ).results;
  const covered = new Set<string>();
  for (const row of payloads) {
    try {
      const p = JSON.parse(row.target_payload);
      if (p.extension) covered.add(String(p.extension));
      if (p.phoneNumber) covered.add(String(p.phoneNumber));
    } catch {
      /* our own JSON */
    }
  }
  // Which device carries each line (explains *why* it has no path, e.g. CTI ports).
  const deviceByLine = new Map<string, { device: string; model: string | null; owner: string | null }>();
  const phones = (
    await env.DB.prepare("SELECT device_name, model, owner_userid, lines_json FROM src_phones WHERE project_id = ?")
      .bind(projectId)
      .all<{ device_name: string; model: string | null; owner_userid: string | null; lines_json: string | null }>()
  ).results;
  for (const ph of phones) {
    try {
      for (const dn of JSON.parse(ph.lines_json ?? "[]") as string[]) {
        if (!deviceByLine.has(dn)) deviceByLine.set(dn, { device: ph.device_name, model: ph.model, owner: ph.owner_userid });
      }
    } catch {
      /* our own JSON */
    }
  }
  return lines
    .map((l) => l.pattern)
    .filter((pattern) => !covered.has(pattern) && !covered.has(sanitizeExtension(pattern).extension))
    .map((pattern) => {
      const dev = deviceByLine.get(pattern);
      return { pattern, device: dev?.device ?? null, model: dev?.model ?? null, owner: dev?.owner ?? null };
    });
}

/**
 * Cumulative outgoing-call permission classes. Each level includes all the
 * levels below it: internal < toll_free < national < international.
 */
export const CALL_PERMISSION_LEVELS = ["internal", "toll_free", "national", "international"] as const;
export type CallPermissionLevel = (typeof CALL_PERMISSION_LEVELS)[number];

const PERMISSION_CALL_TYPES: { type: string; rank: number }[] = [
  { type: "INTERNAL_CALL", rank: 0 },
  { type: "TOLL_FREE", rank: 1 },
  { type: "NATIONAL", rank: 2 },
  { type: "INTERNATIONAL", rank: 3 },
];

/** Webex outgoingPermission entries for a class (ALLOW everything at or below the level). */
export function callPermissionsFor(level: CallPermissionLevel): { callType: string; action: "ALLOW" | "BLOCK"; transferEnabled: boolean }[] {
  const rank = CALL_PERMISSION_LEVELS.indexOf(level);
  return PERMISSION_CALL_TYPES.map((t) => ({
    callType: t.type,
    action: t.rank <= rank ? "ALLOW" : "BLOCK",
    transferEnabled: t.rank <= rank,
  }));
}

type SrcCallHandler = { id: string; object_id: string; name: string; extension: string | null; menu_json: string | null };
type MenuTarget = { kind: "user" | "handler"; name: string; extension: string | null };

/**
 * Unity call handler → Webex auto attendant. Menu keys are translated where
 * a clean equivalent exists; everything else is preserved as a note so the
 * engineer designs the rest in Control Hub rather than losing it.
 */
export function buildAutoAttendantMapping(handler: SrcCallHandler, targets: Map<string, MenuTarget>) {
  const notes: string[] = [];
  let confidence: "green" | "amber" | "red" = "amber";

  let menu: any[] = [];
  try {
    menu = JSON.parse(handler.menu_json ?? "[]");
  } catch {
    /* our own ingest */
  }

  const keys: { key: string; action: string; value?: string; description: string }[] = [];
  const unmapped: string[] = [];
  for (const entry of menu) {
    const key = String(entry.TouchtoneKey ?? "");
    const action = String(entry.Action ?? "0");
    if (!key || action === "0") continue; // ignored keys
    if (action === "1") {
      keys.push({ key, action: "EXIT", description: "hang up" });
    } else if (action === "6") {
      keys.push({ key, action: "REPEAT_MENU", description: "repeat greeting" });
    } else if (action === "7" && entry.TransferNumber) {
      keys.push({ key, action: "TRANSFER_WITHOUT_PROMPT", value: String(entry.TransferNumber), description: `transfer to ${entry.TransferNumber}` });
    } else if (action === "2" && entry.TargetHandlerObjectId) {
      const target = targets.get(String(entry.TargetHandlerObjectId));
      if (target?.extension) {
        keys.push({
          key,
          action: "TRANSFER_WITHOUT_PROMPT",
          value: target.extension,
          description: `transfer to ${target.kind === "user" ? "user" : "handler"} ${target.name} (${target.extension})`,
        });
      } else {
        unmapped.push(`${key} → ${target ? `${target.name} (no extension)` : `handler ${entry.TargetHandlerObjectId}`}`);
      }
    } else if (action === "2" && entry.TargetConversation) {
      unmapped.push(`${key} → conversation ${entry.TargetConversation}`);
    } else {
      unmapped.push(`${key} → Unity action ${action}`);
    }
  }
  if (unmapped.length > 0) {
    notes.push(`Menu keys with no Webex equivalent (configure manually): ${unmapped.join("; ")}`);
  }
  if (keys.length === 0) {
    notes.push("No menu keys translated — the auto attendant will be created with a repeat-menu key only");
  }

  let extension = handler.extension ?? null;
  if (extension) {
    const fixed = sanitizeExtension(extension);
    if (!fixed.valid) {
      confidence = "red";
      notes.push(`Handler number "${extension}" is not a plain extension`);
    }
    extension = fixed.extension;
  } else {
    notes.push("Handler has no extension in Unity — assign one before pushing (auto attendants need a number or extension)");
    confidence = "red";
  }
  notes.push("Greeting audio is not uploaded automatically for auto attendants in v1 — re-record or upload in Control Hub");

  const payload = {
    name: handler.name,
    extension,
    keys,
    unmappedKeys: unmapped,
    locationName: null as string | null,
    cucmSite: null as string | null,
  };
  return { payload, confidence, notes };
}

/** Combine a site's E.164 prefix with an extension; null when the result isn't valid E.164. */
export function e164FromExtension(prefix: string, extension: string): string | null {
  const p = prefix.trim().replace(/[\s().-]/g, "");
  if (!/^\+\d{1,12}$/.test(p)) return null;
  const combined = `${p}${extension}`;
  return /^\+\d{7,15}$/.test(combined) ? combined : null;
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
  // Re-ingesting replaces src rows (new ids) — drop mappings that now point at nothing.
  const orphanCleanup: [string, string][] = [
    ["user", "src_users"],
    ["hunt_pilot", "src_hunt_pilots"],
    ["pickup_group", "src_pickup_groups"],
    ["trans_pattern", "src_trans_patterns"],
    ["route_pattern", "src_dialplan"],
    ["call_park", "src_dialplan"],
    ["phone", "src_phones"],
    ["call_handler", "src_call_handlers"],
  ];
  for (const [srcType, table] of orphanCleanup) {
    await env.DB.prepare(
      `DELETE FROM mappings WHERE project_id = ? AND src_type = ? AND src_id NOT IN (SELECT id FROM ${table} WHERE project_id = ?)`,
    )
      .bind(projectId, srcType, projectId)
      .run();
  }
  const users = (await env.DB.prepare("SELECT * FROM src_users WHERE project_id = ?").bind(projectId).all<SrcUser>()).results;
  const vmBoxes = (
    await env.DB.prepare(
      `SELECT b.alias, b.extension,
         (SELECT g.r2_key FROM src_vm_greetings g WHERE g.project_id = b.project_id AND g.matched_alias = b.alias LIMIT 1) AS greeting_key
       FROM src_vm_boxes b WHERE b.project_id = ?`,
    )
      .bind(projectId)
      .all<SrcVmBox>()
  ).results;
  const pilots = (await env.DB.prepare("SELECT * FROM src_hunt_pilots WHERE project_id = ?").bind(projectId).all<SrcHuntPilot>()).results;
  const pickups = (await env.DB.prepare("SELECT * FROM src_pickup_groups WHERE project_id = ?").bind(projectId).all<SrcPickup>()).results;
  const transPatterns = (await env.DB.prepare("SELECT * FROM src_trans_patterns WHERE project_id = ?").bind(projectId).all<SrcTransPattern>()).results;
  const routePatterns = (
    await env.DB.prepare("SELECT id, name, partition_name, description FROM src_dialplan WHERE project_id = ? AND object_type = 'route_pattern'")
      .bind(projectId)
      .all<SrcRoutePattern>()
  ).results;
  const callParks = (
    await env.DB.prepare("SELECT id, name, partition_name, description FROM src_dialplan WHERE project_id = ? AND object_type = 'call_park'")
      .bind(projectId)
      .all<SrcRoutePattern>()
  ).results;
  const callHandlers = (
    await env.DB.prepare("SELECT id, object_id, name, extension, menu_json FROM src_call_handlers WHERE project_id = ?")
      .bind(projectId)
      .all<SrcCallHandler>()
  ).results;

  // Site context: a user's site is the device pool (fallback: CUCM location)
  // of their owned phone; the human-confirmed site → Webex location mapping
  // lives in site_mappings.
  const phones = (
    await env.DB.prepare(
      "SELECT id, device_name, description, model, owner_userid, device_pool, location_name, lines_json FROM src_phones WHERE project_id = ?",
    )
      .bind(projectId)
      .all<SrcPhone>()
  ).results;
  const siteByUser = new Map<string, string>();
  for (const p of phones) {
    const site = p.device_pool || p.location_name;
    if (p.owner_userid && site && !siteByUser.has(p.owner_userid.toLowerCase())) {
      siteByUser.set(p.owner_userid.toLowerCase(), site);
    }
  }
  const siteToLocation = new Map<string, string>();
  const siteToPrefix = new Map<string, string>();
  for (const row of (
    await env.DB.prepare("SELECT cucm_site, webex_location, e164_prefix FROM site_mappings WHERE project_id = ?")
      .bind(projectId)
      .all<{ cucm_site: string; webex_location: string | null; e164_prefix: string | null }>()
  ).results) {
    if (row.webex_location) siteToLocation.set(row.cucm_site, row.webex_location);
    if (row.e164_prefix) siteToPrefix.set(row.cucm_site, row.e164_prefix);
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
  // Everything starts deselected — migration scope is an explicit opt-in.
  const upsert = (srcType: string, srcId: string, targetType: string, payload: unknown, confidence: string, notes: string[], selectedDefault = 0) => {
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

  // Shared lines are kept on every sharer (Webex supports shared line
  // appearances) — annotate so the engineer knows only one person can be the
  // number's primary owner; the push falls back to numberless for the rest.
  const sharers = new Map<string, string[]>();
  for (const user of users) {
    const n = user.primary_extension?.trim();
    if (!n) continue;
    if (!sharers.has(n)) sharers.set(n, []);
    sharers.get(n)!.push(user.userid);
  }
  for (const user of users) {
    const built = buildPersonMapping(user, vmBoxes);
    let { confidence } = built;
    const { payload, notes } = built;
    const number = payload.phoneNumber ?? payload.extension;
    const sharedWith = number ? (sharers.get(user.primary_extension?.trim() ?? "") ?? []).filter((u) => u !== user.userid) : [];
    if (sharedWith.length > 0) {
      notes.push(
        `Shared line: ${number} is also the primary extension of ${sharedWith.join(", ")} — Webex allows one primary owner; the others are created without the number, then configure shared line appearances on their devices in Control Hub`,
      );
      if (confidence === "green") confidence = "amber";
    }
    const site = siteOf(user.userid);
    // Optional per-site E.164 conversion: extension becomes a DID, extension kept.
    const prefix = site ? siteToPrefix.get(site) : undefined;
    if (prefix && payload.extension && !payload.phoneNumber) {
      const did = e164FromExtension(prefix, payload.extension);
      if (did) {
        payload.phoneNumber = did;
        notes.push(`E.164 conversion: extension ${payload.extension} → ${did} (site prefix ${prefix})`);
      } else {
        if (confidence === "green") confidence = "amber";
        notes.push(`E.164 conversion failed: "${prefix}" + ${payload.extension} is not a valid E.164 number — check the site prefix`);
      }
    }
    upsert(
      "user",
      user.id,
      "person",
      { ...payload, cucmSite: site, locationName: locationFor(site), sharedLineWith: sharedWith, callPermission: "international" },
      confidence,
      notes,
    );
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
  // Resolve TP destinations against the full route plan: what kind of object
  // is the target, in which partition, and which device carries it.
  const dialplanByPattern = new Map<string, { type: string; partition: string | null }[]>();
  for (const row of (
    await env.DB.prepare(
      `SELECT name, object_type, partition_name FROM src_dialplan WHERE project_id = ?
       AND object_type NOT IN ('route_partition','css','route_list','route_group','sip_trunk')`,
    )
      .bind(projectId)
      .all<{ name: string; object_type: string; partition_name: string | null }>()
  ).results) {
    if (!dialplanByPattern.has(row.name)) dialplanByPattern.set(row.name, []);
    dialplanByPattern.get(row.name)!.push({ type: row.object_type, partition: row.partition_name });
  }
  const usersById = new Map(users.map((u) => [u.userid.toLowerCase(), u]));
  const deviceByLine = new Map<string, { name: string; model: string | null; ownerName: string | null }>();
  for (const ph of phones) {
    try {
      for (const dn of JSON.parse(ph.lines_json ?? "[]") as string[]) {
        if (deviceByLine.has(dn)) continue;
        const owner = ph.owner_userid ? usersById.get(ph.owner_userid.toLowerCase()) : null;
        deviceByLine.set(dn, {
          name: ph.device_name,
          model: ph.model,
          ownerName: owner ? [owner.first_name, owner.last_name].filter(Boolean).join(" ") || owner.userid : (ph.owner_userid ?? null),
        });
      }
    } catch {
      /* our own JSON */
    }
  }
  const resolveDestination = (mask: string | null): DestinationInfo | null => {
    const m = mask?.trim();
    if (!m || /[Xx\[\]!*#?]/.test(m)) return null; // wildcard masks resolve per-call
    const clean = m.replace(/[.\\/\s]/g, "");
    const entries = dialplanByPattern.get(clean) ?? dialplanByPattern.get(m) ?? [];
    const device = deviceByLine.get(clean) ?? deviceByLine.get(m) ?? null;
    return { pattern: clean, exists: entries.length > 0 || !!device, entries, device };
  };

  for (const tp of transPatterns) {
    const { payload, confidence, notes } = buildTranslationPatternMapping(tp, knownExtensions, resolveDestination(tp.called_party_mask));
    // Deselected by default: digit manipulation always needs engineer review.
    upsert("trans_pattern", tp.id, "translation_pattern", payload, confidence, notes, 0);
  }
  for (const rp of routePatterns) {
    const { payload, confidence, notes } = buildRoutePatternMapping(rp);
    upsert("route_pattern", rp.id, "route_pattern", payload, confidence, notes);
  }
  // Menu-key target resolution: handler object ids → users (primary handlers
  // via mailbox CallHandlerObjectId) or other call handlers.
  const menuTargets = new Map<string, MenuTarget>();
  for (const h of callHandlers) {
    menuTargets.set(h.object_id, { kind: "handler", name: h.name, extension: h.extension });
  }
  const vmBoxRaw = (
    await env.DB.prepare("SELECT alias, extension, raw_json FROM src_vm_boxes WHERE project_id = ?")
      .bind(projectId)
      .all<{ alias: string; extension: string | null; raw_json: string }>()
  ).results;
  for (const box of vmBoxRaw) {
    try {
      const chId = JSON.parse(box.raw_json)?.CallHandlerObjectId;
      if (chId) menuTargets.set(String(chId), { kind: "user", name: box.alias, extension: box.extension });
    } catch {
      /* our own JSON */
    }
  }
  const defaultSite = mostCommon([...siteByUser.values()]);
  for (const ch of callHandlers) {
    const { payload, confidence, notes } = buildAutoAttendantMapping(ch, menuTargets);
    upsert("call_handler", ch.id, "auto_attendant", { ...payload, cucmSite: defaultSite, locationName: locationFor(defaultSite) }, confidence, notes, 0);
  }

  for (const cp of callParks) {
    const { payload, confidence, notes } = buildCallParkMapping(cp);
    // Park extensions are location-scoped; default to the most common site's location.
    const site = mostCommon([...siteByUser.values()]);
    upsert("call_park", cp.id, "call_park", { ...payload, cucmSite: site, locationName: locationFor(site) }, confidence, notes);
  }
  // Owner-less phones with at least one line become workspaces (common area).
  for (const phone of phones) {
    if (phone.owner_userid) continue;
    let hasLines = false;
    try {
      hasLines = JSON.parse(phone.lines_json ?? "[]").length > 0;
    } catch {
      /* our own ingest */
    }
    if (!hasLines) continue;
    const { payload, confidence, notes } = buildWorkspaceMapping(phone);
    const site = phone.device_pool || phone.location_name;
    upsert("phone", phone.id, "workspace", { ...payload, cucmSite: site, locationName: locationFor(site) }, confidence, notes);
  }

  await batchAll(env.DB, stmts);

  // Re-apply user-forced voicemail choices to freshly regenerated rows.
  await env.DB.prepare(
    `UPDATE mappings SET target_payload = json_set(target_payload, '$.voicemail', json(CASE vm_override WHEN 1 THEN 'true' ELSE 'false' END))
     WHERE project_id = ? AND target_type = 'person' AND vm_override IS NOT NULL AND status = 'auto'`,
  )
    .bind(projectId)
    .run();
  // Re-apply chosen call-permission classes (default is international).
  await env.DB.prepare(
    `UPDATE mappings SET target_payload = json_set(target_payload, '$.callPermission', call_permission)
     WHERE project_id = ? AND target_type = 'person' AND call_permission IS NOT NULL AND status = 'auto'`,
  )
    .bind(projectId)
    .run();

  return { generated: stmts.length };
}
