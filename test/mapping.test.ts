import { describe, expect, it } from "vitest";
import { buildHuntGroupMapping, buildPersonMapping, buildPickupMapping, buildRoutePatternMapping, buildTranslationPatternMapping, buildWorkspaceMapping, checkTranslationPatternRules, mapHuntPolicy, recheckMapping, sanitizeExtension, sanitizePattern } from "../src/mapping/engine";

const user = (over: Partial<Record<string, string | null>> = {}) => ({
  id: "u1",
  userid: "jdoe",
  first_name: "John",
  last_name: "Doe",
  email: "jdoe@example.com",
  primary_extension: "1001",
  ...over,
});

describe("mapHuntPolicy", () => {
  it("maps the four CUCM algorithms", () => {
    expect(mapHuntPolicy("Top Down").policy).toBe("REGULAR");
    expect(mapHuntPolicy("Circular").policy).toBe("CIRCULAR");
    expect(mapHuntPolicy("Longest Idle Time").policy).toBe("UNIFORM");
    expect(mapHuntPolicy("Broadcast").policy).toBe("SIMULTANEOUS");
  });
  it("defaults with a note for unknown algorithms", () => {
    const r = mapHuntPolicy("Weird");
    expect(r.policy).toBe("REGULAR");
    expect(r.note).toContain("Weird");
  });
});

describe("buildPersonMapping", () => {
  it("is green with email and extension", () => {
    const { confidence, payload } = buildPersonMapping(user(), []);
    expect(confidence).toBe("green");
    expect(payload.extension).toBe("1001");
    expect(payload.displayName).toBe("John Doe");
  });
  it("is red without email", () => {
    const { confidence, notes } = buildPersonMapping(user({ email: null }), []);
    expect(confidence).toBe("red");
    expect(notes.join(" ")).toMatch(/email/i);
  });
  it("treats an E.164 primary extension as a phone number", () => {
    const { payload } = buildPersonMapping(user({ primary_extension: "+441onefake" }), []);
    expect(payload.phoneNumber).toBeNull(); // not E.164
    const e164 = buildPersonMapping(user({ primary_extension: "+441234567890" }), []);
    expect(e164.payload.phoneNumber).toBe("+441234567890");
    expect(e164.payload.extension).toBeNull();
  });
  it("flags voicemail when a Unity box matches by extension or alias", () => {
    expect(buildPersonMapping(user(), [{ alias: "other", extension: "1001" }]).payload.voicemail).toBe(true);
    expect(buildPersonMapping(user(), [{ alias: "JDOE", extension: null }]).payload.voicemail).toBe(true);
    expect(buildPersonMapping(user(), [{ alias: "nobody", extension: "9999" }]).payload.voicemail).toBe(false);
  });
});

describe("buildHuntGroupMapping", () => {
  const pilot = { id: "h1", pattern: "2000", description: "Support", algorithm: "Circular", raw_json: "{}" };
  const usersByExt = new Map([["1001", user() as any]]);

  it("resolves members to emails and maps the policy", () => {
    const { payload, confidence } = buildHuntGroupMapping(pilot, ["1001"], usersByExt);
    expect(payload.policy).toBe("CIRCULAR");
    expect(payload.agentEmails).toEqual(["jdoe@example.com"]);
    expect(payload.name).toBe("Support");
    expect(confidence).toBe("green");
  });
  it("goes amber with unresolved members", () => {
    const { confidence, payload } = buildHuntGroupMapping(pilot, ["1001", "1099"], usersByExt);
    expect(confidence).toBe("amber");
    expect(payload.unresolvedMembers).toEqual(["1099"]);
  });
  it("flags multi-line-group pilots for review", () => {
    const multi = { ...pilot, raw_json: JSON.stringify({ multiLineGroup: true }) };
    const { confidence, notes } = buildHuntGroupMapping(multi, ["1001"], usersByExt);
    expect(confidence).toBe("amber");
    expect(notes.join(" ")).toMatch(/multiple line groups/i);
  });
});

describe("buildTranslationPatternMapping", () => {
  const tp = (over: Partial<Record<string, string | null>> = {}) => ({
    id: "t1",
    pattern: "8XXX",
    partition_name: "PT-Internal",
    description: "DID alias",
    called_party_mask: null as string | null,
    prefix_digits: null as string | null,
    ...over,
  });

  it("is amber with a mask-derived replacement", () => {
    const { payload, confidence } = buildTranslationPatternMapping(tp({ called_party_mask: "1001" }), new Set());
    expect(confidence).toBe("amber");
    expect(payload.matchingPattern).toBe("8XXX");
    expect(payload.replacementPattern).toBe("1001");
  });

  it("notes when the mask resolves to a known extension", () => {
    const { notes } = buildTranslationPatternMapping(tp({ called_party_mask: "1001" }), new Set(["1001"]));
    expect(notes.join(" ")).toMatch(/resolves to internal extension 1001/);
  });

  it("is red for prefix-digit patterns", () => {
    const { confidence, payload } = buildTranslationPatternMapping(tp({ prefix_digits: "9" }), new Set());
    expect(confidence).toBe("red");
    expect(payload.replacementPattern).toBeNull();
  });

  it("is red with no transformation at all", () => {
    expect(buildTranslationPatternMapping(tp(), new Set()).confidence).toBe("red");
  });
});

describe("sanitizePattern / sanitizeExtension", () => {
  it("removes dots, slashes, backslashes and whitespace", () => {
    const r = sanitizePattern("9.1\\23/4 5XX");
    expect(r.pattern).toBe("912345XX");
    expect(r.removed).toEqual(expect.arrayContaining([".", "\\", "/", " "]));
    expect(r.unsupported).toEqual([]);
  });
  it("reports characters Webex cannot express", () => {
    expect(sanitizePattern("9.@").unsupported).toEqual(["@"]);
    expect(sanitizePattern("8?X").unsupported).toEqual(["?"]);
  });
  it("keeps Webex-legal wildcard syntax", () => {
    expect(sanitizePattern("+44[2-5]XX!").unsupported).toEqual([]);
  });
  it("corrects extensions to plain digits and flags non-numeric leftovers", () => {
    expect(sanitizeExtension("20.01")).toMatchObject({ extension: "2001", valid: true });
    expect(sanitizeExtension("20X1").valid).toBe(false);
  });
});

describe("checkTranslationPatternRules (Webex hard rules)", () => {
  it('rejects "*+" in matching or destination', () => {
    expect(checkTranslationPatternRules("*+XXXX", null)).toHaveLength(1);
    expect(checkTranslationPatternRules("8XXX", "*+1234")).toHaveLength(1);
    expect(checkTranslationPatternRules("8XXX", "1234")).toHaveLength(0);
  });
  it("rejects X wildcards in the destination", () => {
    expect(checkTranslationPatternRules("8XXX", "1XXX").join(" ")).toMatch(/cannot contain X/);
    expect(checkTranslationPatternRules("8XXX", "1001")).toHaveLength(0);
  });
  it("blocks the mapping when the source pattern violates the rules", () => {
    const { confidence, notes } = buildTranslationPatternMapping(
      { id: "t9", pattern: "*+XXXX", partition_name: null, description: null, called_party_mask: "1001", prefix_digits: null },
      new Set(),
    );
    expect(confidence).toBe("red");
    expect(notes.join(" ")).toMatch(/\*\+/);
  });
  it("blocks an X-wildcard mask", () => {
    const { confidence } = buildTranslationPatternMapping(
      { id: "t10", pattern: "8XXX", partition_name: null, description: null, called_party_mask: "1XXX", prefix_digits: null },
      new Set(),
    );
    expect(confidence).toBe("red");
  });
});

describe("recheckMapping (after user edit)", () => {
  it("clears a translation pattern block once the X wildcard is removed", () => {
    const before = recheckMapping("translation_pattern", { matchingPattern: "8XXX", replacementPattern: "1XXX" });
    expect(before.confidence).toBe("red");
    const after = recheckMapping("translation_pattern", { matchingPattern: "8XXX", replacementPattern: "1001" });
    expect(after.confidence).toBe("amber"); // fixed — verify-semantics note remains
  });
  it("keeps a person blocked while the email is invalid, clears when fixed", () => {
    expect(recheckMapping("person", { email: "not-an-email", extension: "1001" }).confidence).toBe("red");
    expect(recheckMapping("person", { email: "a@b.com", extension: "1001" }).confidence).toBe("green");
  });
  it("validates route pattern syntax on edit", () => {
    expect(recheckMapping("route_pattern", { dialPattern: "9@" }).confidence).toBe("red");
    expect(recheckMapping("route_pattern", { dialPattern: "9XXXXXXXXXX" }).confidence).toBe("amber");
  });
});

describe("translation pattern destination resolution", () => {
  const tpRow = { id: "t1", pattern: "8XXX", partition_name: null, description: null, called_party_mask: "6018", prefix_digits: null };

  it("blocks when the destination does not exist in the route plan", () => {
    const { confidence, notes } = buildTranslationPatternMapping(tpRow, new Set(), { pattern: "6018", exists: false, entries: [] });
    expect(confidence).toBe("red");
    expect(notes.join(" ")).toMatch(/does not exist anywhere in the CUCM route plan/);
  });

  it("describes type, partition and carrying device when the destination exists", () => {
    const { confidence, notes, payload } = buildTranslationPatternMapping(tpRow, new Set(), {
      pattern: "6018",
      exists: true,
      entries: [{ type: "directory_number", partition: "PT-dCloud" }],
      device: { name: "SEP001122334455", model: "Cisco 8845", ownerName: "John Doe" },
    });
    expect(confidence).toBe("amber");
    const text = notes.join(" ");
    expect(text).toMatch(/directory number in partition PT-dCloud/);
    expect(text).toMatch(/SEP001122334455 \(Cisco 8845, John Doe\)/);
    expect((payload as any).destination.exists).toBe(true);
  });
});

describe("hunt group agent details", () => {
  it("includes agent name and extension alongside email", () => {
    const usersByExt = new Map([["1001", user() as any]]);
    const { payload } = buildHuntGroupMapping(
      { id: "h1", pattern: "2000", description: "Support", algorithm: "Circular", raw_json: "{}" },
      ["1001"],
      usersByExt,
    );
    expect((payload as any).agentDetails).toEqual([{ email: "jdoe@example.com", name: "John Doe", extension: "1001" }]);
  });
});

describe("e164FromExtension", () => {
  it("combines prefix and extension into E.164", async () => {
    const { e164FromExtension } = await import("../src/mapping/engine");
    expect(e164FromExtension("+44207555", "6016")).toBe("+442075556016");
    expect(e164FromExtension(" +1 (972) 555", "4100")).toBe("+19725554100");
  });
  it("rejects invalid prefixes and over-long results", async () => {
    const { e164FromExtension } = await import("../src/mapping/engine");
    expect(e164FromExtension("44207", "6016")).toBeNull();
    expect(e164FromExtension("+4420755512345", "601678")).toBeNull();
  });
});

describe("callPermissionsFor (cumulative classes)", () => {
  it("internal allows only internal", async () => {
    const { callPermissionsFor } = await import("../src/mapping/engine");
    const perms = callPermissionsFor("internal");
    expect(perms.find((p) => p.callType === "INTERNAL_CALL")!.action).toBe("ALLOW");
    expect(perms.find((p) => p.callType === "TOLL_FREE")!.action).toBe("BLOCK");
    expect(perms.find((p) => p.callType === "NATIONAL")!.action).toBe("BLOCK");
    expect(perms.find((p) => p.callType === "INTERNATIONAL")!.action).toBe("BLOCK");
  });
  it("national includes toll free and internal but not international", async () => {
    const { callPermissionsFor } = await import("../src/mapping/engine");
    const perms = callPermissionsFor("national");
    expect(perms.filter((p) => p.action === "ALLOW").map((p) => p.callType).sort()).toEqual(["INTERNAL_CALL", "NATIONAL", "TOLL_FREE"]);
  });
  it("international allows everything", async () => {
    const { callPermissionsFor } = await import("../src/mapping/engine");
    expect(callPermissionsFor("international").every((p) => p.action === "ALLOW")).toBe(true);
  });
});

describe("buildCallParkMapping", () => {
  it("maps a literal park number", async () => {
    const { buildCallParkMapping } = await import("../src/mapping/engine");
    const { payload, confidence } = buildCallParkMapping({ id: "cp1", name: "5400", partition_name: null, description: "Floor 1 park" });
    expect(payload.extension).toBe("5400");
    expect(payload.name).toBe("Floor 1 park");
    expect(confidence).toBe("green");
  });
  it("blocks a range with guidance", async () => {
    const { buildCallParkMapping } = await import("../src/mapping/engine");
    const { payload, confidence, notes } = buildCallParkMapping({ id: "cp2", name: "54XX", partition_name: null, description: null });
    expect(confidence).toBe("red");
    expect(payload.extension).toBeNull();
    expect(notes.join(" ")).toMatch(/range/i);
  });
});

describe("buildRoutePatternMapping", () => {
  it("strips the CUCM pre-dot and flags for review", () => {
    const { payload, confidence, notes } = buildRoutePatternMapping({ id: "r1", name: "9.XXXXXXXXXX", partition_name: "PT-PSTN", description: "Local calls" });
    expect(payload.dialPattern).toBe("9XXXXXXXXXX");
    expect(payload.cucmPattern).toBe("9.XXXXXXXXXX");
    expect(confidence).toBe("amber");
    expect(notes.join(" ")).toMatch(/pattern corrected/i);
    expect(payload.routeChoice).toBeNull();
  });

  it("goes red on characters Webex cannot express", () => {
    const { confidence } = buildRoutePatternMapping({ id: "r2", name: "9.@", partition_name: null, description: null });
    expect(confidence).toBe("red");
  });
});

describe("buildWorkspaceMapping", () => {
  const phone = (over: Partial<Record<string, string | null>> = {}) => ({
    id: "ph1",
    device_name: "SEP001122334455",
    description: "Lobby Phone",
    model: "Cisco 8845",
    owner_userid: null,
    device_pool: "dCloud_DP",
    location_name: null,
    lines_json: '["7200"]',
    ...over,
  });

  it("maps an owner-less phone with one line to a workspace", () => {
    const { payload, confidence } = buildWorkspaceMapping(phone());
    expect(payload.name).toBe("Lobby Phone");
    expect(payload.extension).toBe("7200");
    expect(confidence).toBe("green");
  });

  it("flags extra lines as not migrated", () => {
    const { confidence, notes } = buildWorkspaceMapping(phone({ lines_json: '["7200","7201"]' }));
    expect(confidence).toBe("amber");
    expect(notes.join(" ")).toMatch(/only the first/i);
  });

  it("corrects separators in the line number", () => {
    const { payload, notes } = buildWorkspaceMapping(phone({ lines_json: '["72.00"]' }));
    expect(payload.extension).toBe("7200");
    expect(notes.join(" ")).toMatch(/corrected/i);
  });

  it("treats an E.164 line as the workspace number", () => {
    const { payload } = buildWorkspaceMapping(phone({ lines_json: '["+442071234567"]' }));
    expect(payload.phoneNumber).toBe("+442071234567");
    expect(payload.extension).toBeNull();
  });
});

describe("buildPickupMapping", () => {
  it("resolves members from members_json", () => {
    const usersByExt = new Map([["1001", user() as any]]);
    const { payload, confidence } = buildPickupMapping(
      { id: "p1", name: "Sales Pickup", pattern: "3000", members_json: '["1001"]' },
      usersByExt,
    );
    expect(payload.agentEmails).toEqual(["jdoe@example.com"]);
    expect(confidence).toBe("green");
  });
});
