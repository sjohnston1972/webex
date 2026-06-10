import { describe, expect, it } from "vitest";
import { pickCallingLicense } from "../src/webex/client";

const lic = (name: string, consumed = 0, total = 30) => ({ id: name, name, consumedUnits: consumed, totalUnits: total });

describe("pickCallingLicense", () => {
  it("prefers Professional over Workspaces regardless of order", () => {
    const picked = pickCallingLicense([
      lic("Webex Calling - Workspaces"),
      lic("Webex Calling - Professional"),
      lic("Webex Calling - Hot desk only", 0, 1),
    ]);
    expect(picked.name).toBe("Webex Calling - Professional");
  });

  it("never picks Workspaces or Hot desk licences", () => {
    expect(pickCallingLicense([lic("Webex Calling - Workspaces"), lic("Webex Calling - Hot desk only")])).toBeUndefined();
  });

  it("skips exhausted licences", () => {
    expect(pickCallingLicense([lic("Webex Calling - Professional", 30, 30)])).toBeUndefined();
  });

  it("ignores non-calling licences", () => {
    expect(pickCallingLicense([lic("Webex Meetings Suite"), lic("Basic Messaging")])).toBeUndefined();
  });
});
