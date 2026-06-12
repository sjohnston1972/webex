import type { Env } from "../env";
import { pickCallingLicense, WebexClient } from "../webex/client";

type ItemRow = {
  id: string;
  mapping_id: string;
  target_type: string;
  target_payload: string;
  src_type: string;
};

/** Dry run: traffic-light every item in a batch using Webex read APIs. */
export async function validateBatch(env: Env, projectId: string, batchId: string): Promise<{ green: number; amber: number; red: number }> {
  const client = await WebexClient.forProject(env, projectId);
  await env.DB.prepare("UPDATE batches SET status = 'validating' WHERE id = ?").bind(batchId).run();

  const items = (
    await env.DB.prepare(
      `SELECT bi.id, bi.mapping_id, m.target_type, m.target_payload, m.src_type
       FROM batch_items bi JOIN mappings m ON m.id = bi.mapping_id
       WHERE bi.batch_id = ?`,
    )
      .bind(batchId)
      .all<ItemRow>()
  ).results;

  // Preload org-wide context once.
  const locations = await client.listLocations();
  const locationByName = new Map(locations.map((l: any) => [String(l.name).toLowerCase(), l]));
  const licenses = await client.listLicenses();
  const callingLicense = pickCallingLicense(licenses);
  // Premises PSTN context for route-pattern items (best effort).
  let premisesTargets = 0;
  try {
    premisesTargets = (await client.listPremisesTrunks()).length + (await client.listPremisesRouteGroups()).length;
  } catch {
    premisesTargets = 0;
  }

  // Existing org objects — so the dry run predicts duplicate collisions.
  const safe = async <T>(fn: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const [existingHunt, existingAAs, existingWorkspaces, existingTPs, existingParks, existingDialPlans] = await Promise.all([
    safe(() => client.listHuntGroups()),
    safe(() => client.listAutoAttendants()),
    safe(() => client.listWorkspaces()),
    safe(() => client.listTranslationPatterns()),
    safe(() => client.listCallParkExtensions()),
    safe(() => client.listDialPlans()),
  ]);
  const existingDialPatterns = new Map<string, string>(); // pattern -> dial plan name
  for (const plan of existingDialPlans) {
    for (const p of await safe(() => client.getDialPlanPatterns(plan.id))) {
      existingDialPatterns.set(p, plan.name);
    }
  }
  // Pickup groups are location-scoped — fetch only the locations this batch touches.
  const existingPickups: { name: string; locationId: string }[] = [];
  {
    const pickupLocationIds = new Set<string>();
    for (const item of items) {
      if (item.target_type !== "call_pickup") continue;
      const p = JSON.parse(item.target_payload);
      const loc = locationByName.get(String(p.locationName ?? "").toLowerCase());
      if (loc) pickupLocationIds.add(loc.id);
    }
    for (const locId of pickupLocationIds) {
      for (const cp of await safe(() => client.listCallPickups(locId))) {
        existingPickups.push({ name: String(cp.name), locationId: locId });
      }
    }
  }

  const numbers = await client.listNumbers();
  const numberByE164 = new Map(numbers.map((n: any) => [n.phoneNumber, n]));
  const extensionsInUse = new Set(numbers.filter((n: any) => n.owner).map((n: any) => String(n.extension ?? "")));

  // Emails of people being created in this same batch (for group member checks).
  const batchEmails = new Set<string>();
  for (const item of items) {
    if (item.target_type === "person") {
      const p = JSON.parse(item.target_payload);
      if (p.email) batchEmails.add(String(p.email).toLowerCase());
    }
  }

  let green = 0,
    amber = 0,
    red = 0;

  for (const item of items) {
    const payload = JSON.parse(item.target_payload);
    const notes: string[] = [];
    let status: "green" | "amber" | "red" = "green";
    const worsen = (s: "amber" | "red") => {
      if (s === "red" || status === "red") status = s === "red" ? "red" : status;
      else status = "amber";
      if (s === "red") status = "red";
    };

    const checkLocation = (): any | null => {
      if (!payload.locationName) {
        worsen("red");
        notes.push("No Webex location set — choose a location on the Review page");
        return null;
      }
      const loc = locationByName.get(String(payload.locationName).toLowerCase());
      if (!loc) {
        worsen("red");
        notes.push(`Location "${payload.locationName}" does not exist in Control Hub (v1 does not auto-create locations)`);
        return null;
      }
      return loc;
    };

    try {
      if (item.target_type === "person") {
        if (!payload.email) {
          worsen("red");
          notes.push("No email address");
        } else {
          const existing = await client.findPersonByEmail(payload.email);
          if (existing) {
            worsen("amber");
            notes.push("Person already exists in Webex — push will skip creation and record the existing ID");
          }
        }
        checkLocation();
        if (!callingLicense) {
          worsen("red");
          notes.push("No Webex Calling licence with available units");
        }
        if (payload.phoneNumber) {
          const num = numberByE164.get(payload.phoneNumber);
          if (!num) {
            worsen("red");
            notes.push(`Number ${payload.phoneNumber} is not in the Webex number inventory`);
          } else if (num.owner) {
            worsen("red");
            notes.push(`Number ${payload.phoneNumber} is already assigned to ${num.owner?.firstName ?? ""} ${num.owner?.lastName ?? ""}`.trim());
          }
        } else if (payload.extension && extensionsInUse.has(String(payload.extension))) {
          worsen("amber");
          notes.push(`Extension ${payload.extension} appears to be in use`);
        }
        if (payload.voicemail) {
          notes.push(payload.greetingKey ? "Voicemail will be enabled with the matched Unity greeting" : "Voicemail will be enabled (no greeting file matched — default greeting)");
        }
      } else if (item.target_type === "auto_attendant") {
        checkLocation();
        if (!payload.extension) {
          worsen("red");
          notes.push("No extension — auto attendants need a number; edit the mapping");
        } else if (extensionsInUse.has(String(payload.extension))) {
          worsen("amber");
          notes.push(`Extension ${payload.extension} appears to be in use`);
        }
        if ((payload.unmappedKeys ?? []).length > 0) {
          worsen("amber");
          notes.push(`${payload.unmappedKeys.length} menu key(s) need manual configuration in Control Hub`);
        }
        const dupAA = existingAAs.find(
          (a: any) => String(a.name).toLowerCase() === String(payload.name).toLowerCase() || (payload.extension && String(a.extension) === String(payload.extension)),
        );
        if (dupAA) {
          worsen("amber");
          notes.push(`An auto attendant "${dupAA.name}" (ext ${dupAA.extension ?? "—"}) already exists — push will fail as a duplicate`);
        }
      } else if (item.target_type === "call_park") {
        checkLocation();
        if (!payload.extension) {
          worsen("red");
          notes.push("Range/pattern park number — edit to a single extension before pushing");
        } else if (extensionsInUse.has(String(payload.extension))) {
          worsen("amber");
          notes.push(`Extension ${payload.extension} appears to be in use`);
        }
        if (payload.extension && existingParks.some((pk: any) => String(pk.extension) === String(payload.extension))) {
          worsen("amber");
          notes.push(`A call park extension ${payload.extension} already exists in the org — push will fail as a duplicate`);
        }
      } else if (item.target_type === "workspace") {
        checkLocation();
        const wsLicense = licenses.find(
          (l: any) => /webex calling.*workspaces/i.test(l.name) && (l.totalUnits === undefined || l.consumedUnits < l.totalUnits),
        );
        if (!wsLicense) {
          worsen("amber");
          notes.push("No 'Webex Calling - Workspaces' licence with free units found — workspace calling may fail to provision");
        }
        if (payload.extension && extensionsInUse.has(String(payload.extension))) {
          worsen("amber");
          notes.push(`Extension ${payload.extension} appears to be in use`);
        }
        if (payload.phoneNumber) {
          const num = numberByE164.get(payload.phoneNumber);
          if (!num) {
            worsen("red");
            notes.push(`Number ${payload.phoneNumber} is not in the Webex number inventory`);
          } else if (num.owner) {
            worsen("red");
            notes.push(`Number ${payload.phoneNumber} is already assigned`);
          }
        }
        if (existingWorkspaces.some((w: any) => String(w.displayName).toLowerCase() === String(payload.name).toLowerCase())) {
          worsen("amber");
          notes.push(`A workspace named "${payload.name}" already exists in the org — pushing will create a duplicate`);
        }
      } else if (item.target_type === "translation_pattern") {
        if (!payload.replacementPattern) {
          worsen("red");
          notes.push("No replacement pattern derived from CUCM — edit the mapping or handle manually in Control Hub");
        } else {
          worsen("amber");
          notes.push("Translation patterns push at org level — verify matching/replacement syntax before pushing");
        }
        if (existingTPs.some((t: any) => t.matchingPattern === payload.matchingPattern)) {
          notes.push(`A translation pattern matching "${payload.matchingPattern}" already exists — push will record it as existing (no duplicate created)`);
        }
      } else if (item.target_type === "route_pattern") {
        if (premisesTargets === 0) {
          worsen("red");
          notes.push("No premises PSTN trunks or route groups exist in this org — create a Local Gateway trunk first, or use Cloud PSTN and exclude route patterns");
        }
        if (!payload.routeChoice?.id) {
          worsen("red");
          notes.push("No route target selected — pick a trunk/route group on the Review page");
        } else {
          worsen("amber");
          notes.push(`Will be added to dial plan "CUCM via ${payload.routeChoice.name}" — verify pattern syntax`);
        }
        const planWithPattern = existingDialPatterns.get(String(payload.dialPattern));
        if (planWithPattern) {
          worsen("amber");
          notes.push(`Dial pattern ${payload.dialPattern} already exists in dial plan "${planWithPattern}" — push will fail as a duplicate`);
        }
      } else if (item.target_type === "hunt_group" || item.target_type === "call_pickup") {
        checkLocation();
        const agents: string[] = payload.agentEmails ?? [];
        if (agents.length === 0) {
          worsen("amber");
          notes.push("No resolvable members");
        }
        const missing: string[] = [];
        for (const email of agents) {
          if (batchEmails.has(email.toLowerCase())) continue; // created earlier in this batch
          const person = await client.findPersonByEmail(email);
          if (!person) missing.push(email);
        }
        if (missing.length > 0) {
          worsen("amber");
          notes.push(`Members not in Webex and not in this batch: ${missing.join(", ")}`);
        }
        if (item.target_type === "hunt_group" && payload.extension && extensionsInUse.has(String(payload.extension))) {
          worsen("amber");
          notes.push(`Hunt group extension ${payload.extension} appears to be in use`);
        }
        if (item.target_type === "hunt_group") {
          const dup = existingHunt.find(
            (h: any) => String(h.name).toLowerCase() === String(payload.name).toLowerCase() || (payload.extension && String(h.extension) === String(payload.extension)),
          );
          if (dup) {
            worsen("amber");
            notes.push(`A hunt group "${dup.name}" (ext ${dup.extension ?? "—"}) already exists — push will fail as a duplicate`);
          }
        }
        if (item.target_type === "call_pickup") {
          const loc = locationByName.get(String(payload.locationName ?? "").toLowerCase());
          if (loc && existingPickups.some((cp) => cp.locationId === loc.id && cp.name.toLowerCase() === String(payload.name).toLowerCase())) {
            worsen("amber");
            notes.push(`A call pickup group "${payload.name}" already exists at ${payload.locationName} — push will fail as a duplicate`);
          }
        }
        if ((payload.unresolvedMembers ?? []).length > 0) {
          worsen("amber");
          notes.push(`${payload.unresolvedMembers.length} CUCM member DN(s) never resolved to users`);
        }
      }
    } catch (e) {
      worsen("red");
      notes.push(`Validation error: ${e instanceof Error ? e.message : e}`);
    }

    if (status === "green") green++;
    else if (status === "amber") amber++;
    else red++;

    await env.DB.prepare("UPDATE batch_items SET validate_status = ?, validate_notes = ? WHERE id = ?")
      .bind(status, notes.join("\n") || null, item.id)
      .run();
  }

  await env.DB.prepare("UPDATE batches SET status = 'validated' WHERE id = ?").bind(batchId).run();
  return { green, amber, red };
}
