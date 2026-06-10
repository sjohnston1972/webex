import type { Env } from "../env";
import { decrypt } from "../lib/crypto";
import { batchAll, nowIso, uuid } from "../lib/util";
import { AxlClient, text } from "./client";

export type PullResult = {
  snapshotId: string;
  counts: Record<string, number>;
  warnings: string[];
};

export async function getAxlClient(env: Env, projectId: string): Promise<AxlClient | null> {
  const conn = await env.DB.prepare("SELECT * FROM axl_connections WHERE project_id = ?")
    .bind(projectId)
    .first<{ base_url: string; username: string; password_enc: string }>();
  if (!conn) return null;
  const password = await decrypt(env.ENC_KEY, conn.password_enc);
  return new AxlClient(conn.base_url, conn.username, password);
}

/** Pull all supported config from CUCM via AXL into src_* tables (replaces prior AXL-sourced rows). */
export async function pullFromAxl(env: Env, projectId: string): Promise<PullResult> {
  const axl = await getAxlClient(env, projectId);
  if (!axl) throw new Error("No AXL connection configured for this project");

  const snapshotId = uuid();
  await env.DB.prepare(
    "INSERT INTO source_snapshots (id, project_id, type, source, status) VALUES (?, ?, 'cucm', 'axl', 'parsing')",
  )
    .bind(snapshotId, projectId)
    .run();

  const warnings: string[] = [];
  const counts: Record<string, number> = {};

  try {
    // Replace previous AXL-sourced rows for this project.
    const srcTables = ["src_users", "src_phones", "src_lines", "src_hunt_pilots", "src_hunt_members", "src_pickup_groups", "src_trans_patterns", "src_dialplan"];
    for (const table of srcTables) {
      await env.DB.prepare(
        `DELETE FROM ${table} WHERE project_id = ? AND snapshot_id IN
          (SELECT id FROM source_snapshots WHERE project_id = ? AND source = 'axl')`,
      )
        .bind(projectId, projectId)
        .run();
    }

    // Users
    const users = await axl.listUsers();
    await batchAll(
      env.DB,
      users.map((u) =>
        env.DB.prepare(
          `INSERT INTO src_users (id, project_id, snapshot_id, userid, first_name, last_name, email, department, primary_extension, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uuid(),
          projectId,
          snapshotId,
          text(u.userid),
          text(u.firstName) || null,
          text(u.lastName) || null,
          text(u.mailid) || null,
          text(u.department) || null,
          text(u.primaryExtension?.pattern) || null,
          JSON.stringify(u),
        ),
      ),
    );
    counts.users = users.length;

    // Phones — with their lines (devicenumplanmap), needed to migrate
    // owner-less phones as Webex workspaces.
    const phones = await axl.listPhones();
    const linesByDevice = new Map<string, string[]>();
    try {
      const rows = await axl.sql(
        `select d.name as device, n.dnorpattern as dn, dnpm.numplanindex as idx
         from device d
         join devicenumplanmap dnpm on dnpm.fkdevice = d.pkid
         join numplan n on n.pkid = dnpm.fknumplan
         where d.tkclass = 1
         order by d.name, dnpm.numplanindex`,
      );
      for (const r of rows) {
        const device = text(r.device);
        if (!linesByDevice.has(device)) linesByDevice.set(device, []);
        linesByDevice.get(device)!.push(text(r.dn));
      }
    } catch (e) {
      warnings.push(`Phone line associations unavailable: ${e instanceof Error ? e.message : e}`);
    }
    await batchAll(
      env.DB,
      phones.map((p) =>
        env.DB.prepare(
          `INSERT INTO src_phones (id, project_id, snapshot_id, device_name, description, model, owner_userid, device_pool, location_name, lines_json, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uuid(),
          projectId,
          snapshotId,
          text(p.name),
          text(p.description) || null,
          text(p.model) || null,
          text(p.ownerUserName) || null,
          text(p.devicePoolName) || null,
          text(p.locationName) || null,
          JSON.stringify(linesByDevice.get(text(p.name)) ?? []),
          JSON.stringify(p),
        ),
      ),
    );
    counts.phones = phones.length;

    // Lines
    const lines = await axl.listLines();
    await batchAll(
      env.DB,
      lines.map((l) =>
        env.DB.prepare(
          `INSERT INTO src_lines (id, project_id, snapshot_id, pattern, partition_name, description, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uuid(),
          projectId,
          snapshotId,
          text(l.pattern),
          text(l.routePartitionName) || null,
          text(l.description) || null,
          JSON.stringify(l),
        ),
      ),
    );
    counts.lines = lines.length;

    // Hunt pilots → hunt lists → line groups (flattened members)
    const pilots = await axl.listHuntPilots();
    const pilotStmts: D1PreparedStatement[] = [];
    const memberStmts: D1PreparedStatement[] = [];
    let memberCount = 0;
    for (const pilot of pilots) {
      const pattern = text(pilot.pattern);
      const huntList = text(pilot.huntListName);
      let algorithm = "";
      let multiGroup = false;
      try {
        const lineGroupNames = huntList ? await axl.getHuntListMembers(huntList) : [];
        multiGroup = lineGroupNames.length > 1;
        let position = 0;
        for (const lgName of lineGroupNames) {
          const lg = await axl.getLineGroup(lgName);
          if (!algorithm) algorithm = lg.algorithm;
          for (const dn of lg.members) {
            memberStmts.push(
              env.DB.prepare(
                `INSERT INTO src_hunt_members (id, project_id, snapshot_id, hunt_pilot_pattern, member_dn, position, raw_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              ).bind(uuid(), projectId, snapshotId, pattern, dn, position++, JSON.stringify({ lineGroup: lgName })),
            );
            memberCount++;
          }
        }
      } catch (e) {
        warnings.push(`Hunt pilot ${pattern}: could not resolve members (${e instanceof Error ? e.message : e})`);
      }
      const raw = { ...pilot, multiLineGroup: multiGroup };
      pilotStmts.push(
        env.DB.prepare(
          `INSERT INTO src_hunt_pilots (id, project_id, snapshot_id, pattern, description, hunt_list, algorithm, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(uuid(), projectId, snapshotId, pattern, text(pilot.description) || null, huntList || null, algorithm || null, JSON.stringify(raw)),
      );
    }
    await batchAll(env.DB, pilotStmts);
    await batchAll(env.DB, memberStmts);
    counts.hunt_pilots = pilots.length;
    counts.hunt_members = memberCount;

    // Translation patterns (non-fatal — older CUCMs may reject some returnedTags)
    try {
      const tps = await axl.listTranslationPatterns();
      await batchAll(
        env.DB,
        tps.map((t) =>
          env.DB.prepare(
            `INSERT INTO src_trans_patterns (id, project_id, snapshot_id, pattern, partition_name, description, called_party_mask, prefix_digits, raw_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            uuid(),
            projectId,
            snapshotId,
            text(t.pattern),
            text(t.routePartitionName) || null,
            text(t.description) || null,
            text(t.calledPartyTransformationMask) || null,
            text(t.prefixDigitsOut) || null,
            JSON.stringify(t),
          ),
        ),
      );
      counts.trans_patterns = tps.length;
    } catch (e) {
      warnings.push(`Translation patterns not pulled: ${e instanceof Error ? e.message : e}`);
    }

    // Pickup groups (+ membership via SQL; non-fatal if the schema query fails)
    const pickups = await axl.listPickupGroups();
    let membersByGroup = new Map<string, string[]>();
    try {
      const rows = await axl.sql(
        "select pg.name as pgname, n.dnorpattern as dn from pickupgroup pg inner join pickupgrouplinemap m on m.fkpickupgroup = pg.pkid inner join numplan n on n.pkid = m.fknumplan_line",
      );
      for (const r of rows) {
        const g = text(r.pgname);
        const dn = text(r.dn);
        if (!membersByGroup.has(g)) membersByGroup.set(g, []);
        membersByGroup.get(g)!.push(dn);
      }
    } catch (e) {
      warnings.push(`Pickup group members unavailable via SQL query: ${e instanceof Error ? e.message : e}`);
    }
    await batchAll(
      env.DB,
      pickups.map((g) => {
        const name = text(g.name);
        return env.DB.prepare(
          `INSERT INTO src_pickup_groups (id, project_id, snapshot_id, name, pattern, members_json, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uuid(),
          projectId,
          snapshotId,
          name,
          text(g.pattern) || null,
          JSON.stringify(membersByGroup.get(name) ?? []),
          JSON.stringify(g),
        );
      }),
    );
    counts.pickup_groups = pickups.length;

    // Full dial plan — CUCM's "Route Plan Report" is the numplan table joined
    // to its usage type; one query captures every pattern in the system.
    const dialplanStmts: D1PreparedStatement[] = [];
    const addDialplan = (objectType: string, name: string, partition: string | null, description: string | null, detail: string | null, raw: unknown) => {
      dialplanStmts.push(
        env.DB.prepare(
          `INSERT INTO src_dialplan (id, project_id, snapshot_id, object_type, name, partition_name, description, detail, raw_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(uuid(), projectId, snapshotId, objectType, name, partition, description, detail, JSON.stringify(raw)),
      );
    };
    const USAGE_TYPES: Record<string, string> = {
      Device: "directory_number",
      Route: "route_pattern",
      Translation: "translation_pattern",
      "Hunt Pilot": "hunt_pilot",
      "Call Pick Up Group": "pickup_group_number",
      CallPark: "call_park",
      "Message Waiting": "message_waiting",
      "Domain Routing": "sip_route_pattern",
      "Emergency Location ID Number": "elin",
      "Centralized Conference Number": "conference",
      "Meet-Me Conference": "meet_me",
      "Device template": "device_template",
    };
    try {
      const rows = await axl.sql(
        `select n.dnorpattern as pattern, tpu.name as usage, rp.name as pname, n.description as descr
         from numplan n
         join typepatternusage tpu on n.tkpatternusage = tpu.enum
         left join routepartition rp on n.fkroutepartition = rp.pkid`,
      );
      for (const r of rows) {
        const usage = text(r.usage);
        addDialplan(USAGE_TYPES[usage] ?? usage.toLowerCase().replace(/[^a-z0-9]+/g, "_"), text(r.pattern), text(r.pname) || null, text(r.descr) || null, `Route plan: ${usage}`, r);
      }
      counts.route_plan_patterns = rows.length;
    } catch (e) {
      warnings.push(`Route plan report query failed: ${e instanceof Error ? e.message : e}`);
    }
    // Supporting dial-plan infrastructure (not patterns, so not in numplan).
    const infraPulls: [string, () => Promise<any[]>, (o: any) => [string, string | null, string | null, string | null]][] = [
      ["route_partition", () => axl.listRoutePartitions(), (o) => [text(o.name), null, text(o.description) || null, null]],
      ["css", () => axl.listCss(), (o) => [text(o.name), null, text(o.description) || null, text(o.clause) ? `Partitions: ${text(o.clause)}` : null]],
      ["route_list", () => axl.listRouteLists(), (o) => [text(o.name), null, text(o.description) || null, null]],
      ["route_group", () => axl.listRouteGroups(), (o) => [text(o.name), null, null, null]],
      ["sip_trunk", () => axl.listSipTrunks(), (o) => [text(o.name), null, text(o.description) || null, null]],
    ];
    let infraCount = 0;
    for (const [objectType, list, map] of infraPulls) {
      try {
        for (const obj of await list()) {
          const [name, partition, description, detail] = map(obj);
          addDialplan(objectType, name, partition, description, detail, obj);
          infraCount++;
        }
      } catch (e) {
        warnings.push(`${objectType} pull failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    counts.dialplan_infrastructure = infraCount;
    await batchAll(env.DB, dialplanStmts);

    await env.DB.prepare(
      "UPDATE source_snapshots SET status = 'parsed', counts_json = ?, parsed_at = ?, error_text = ? WHERE id = ?",
    )
      .bind(JSON.stringify(counts), nowIso(), warnings.length ? warnings.join("\n") : null, snapshotId)
      .run();

    return { snapshotId, counts, warnings };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE source_snapshots SET status = 'failed', error_text = ? WHERE id = ?")
      .bind(msg, snapshotId)
      .run();
    throw e;
  }
}
