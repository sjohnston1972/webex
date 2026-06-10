import { Hono } from "hono";
import type { AppContext } from "../env";
import { WebexClient } from "../webex/client";

export const webex = new Hono<AppContext>();

webex.get("/:id/webex/status", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT org_id, org_name, scopes, expires_at, updated_at FROM webex_tokens WHERE project_id = ?",
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) return c.json({ connected: false });
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    const me = (await client.me()) as any;
    return c.json({ connected: true, ...row, adminEmail: me.emails?.[0] ?? null });
  } catch (e) {
    return c.json({ connected: false, ...row, error: e instanceof Error ? e.message : String(e) });
  }
});

webex.get("/:id/webex/locations", async (c) => {
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    return c.json(await client.listLocations());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

webex.get("/:id/webex/licenses", async (c) => {
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    return c.json(await client.listLicenses());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// Create a location in Control Hub and enable it for Webex Calling.
webex.post("/:id/webex/locations", async (c) => {
  const body = await c.req.json<{ name?: string; timeZone?: string; address?: Record<string, string>; preferredLanguage?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    const details = {
      timeZone: body.timeZone ?? "Europe/London",
      preferredLanguage: body.preferredLanguage ?? "en_GB",
      announcementLanguage: body.preferredLanguage ?? "en_GB",
      address: body.address ?? {
        address1: "1 Example Street",
        city: "London",
        postalCode: "EC1A 1AA",
        country: "GB",
      },
    };
    // Create, or reuse an existing location with the same name.
    let locationId: string;
    try {
      const created = (await client.createLocation({ name: body.name.trim(), ...details })) as any;
      locationId = created.id;
    } catch (e) {
      const existing = (await client.listLocations()).find(
        (l: any) => String(l.name).toLowerCase() === body.name!.trim().toLowerCase(),
      );
      if (!existing) throw e;
      locationId = existing.id;
    }
    let calling = true;
    let callingError: string | null = null;
    try {
      await client.enableLocationCalling({ id: locationId, ...details });
    } catch (e) {
      calling = false;
      callingError = e instanceof Error ? e.message : String(e);
    }
    return c.json({ id: locationId, name: body.name.trim(), callingEnabled: calling, callingError }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

webex.get("/:id/webex/numbers", async (c) => {
  try {
    const client = await WebexClient.forProject(c.env, c.req.param("id"));
    return c.json(await client.listNumbers());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
