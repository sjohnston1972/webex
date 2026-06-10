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
      } else if (item.target_type === "translation_pattern") {
        if (!payload.replacementPattern) {
          worsen("red");
          notes.push("No replacement pattern derived from CUCM — edit the mapping or handle manually in Control Hub");
        } else {
          worsen("amber");
          notes.push("Translation patterns push at org level — verify matching/replacement syntax before pushing");
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
