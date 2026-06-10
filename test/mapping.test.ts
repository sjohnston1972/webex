import { describe, expect, it } from "vitest";
import { buildHuntGroupMapping, buildPersonMapping, buildPickupMapping, mapHuntPolicy } from "../src/mapping/engine";

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
