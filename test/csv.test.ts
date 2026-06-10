import { describe, expect, it } from "vitest";
import { detectKind, parseCsv, parseExport } from "../src/parsers/csv";

describe("parseCsv", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('a,"b,c","d""e"\r\n1,2,3\n');
    expect(rows).toEqual([
      ["a", "b,c", 'd"e'],
      ["1", "2", "3"],
    ]);
  });

  it("strips a BOM and ignores trailing blank lines", () => {
    const rows = parseCsv("﻿x,y\n1,2\n\n");
    expect(rows[0]).toEqual(["x", "y"]);
    expect(rows).toHaveLength(2);
  });
});

describe("detectKind", () => {
  it("detects CUCM user exports", () => {
    expect(detectKind(["USER ID", "FIRST NAME", "LAST NAME", "MAIL ID"])).toBe("users");
  });
  it("detects phone exports", () => {
    expect(detectKind(["Device Name", "Description", "Model"])).toBe("phones");
  });
  it("detects line exports", () => {
    expect(detectKind(["Directory Number", "Route Partition"])).toBe("lines");
  });
  it("detects Unity mailbox exports", () => {
    expect(detectKind(["Alias", "Display Name", "Extension"])).toBe("vm_boxes");
  });
  it("returns unknown otherwise", () => {
    expect(detectKind(["foo", "bar"])).toBe("unknown");
  });
});

describe("parseExport", () => {
  it("maps CUCM user rows to canonical fields", () => {
    const csv = "USER ID,FIRST NAME,LAST NAME,MAIL ID,PRIMARY EXTENSION\njdoe,John,Doe,jdoe@example.com,1001\n";
    const { kind, rows } = parseExport(csv);
    expect(kind).toBe("users");
    expect(rows[0].fields).toMatchObject({
      userid: "jdoe",
      first_name: "John",
      last_name: "Doe",
      email: "jdoe@example.com",
      primary_extension: "1001",
    });
    expect(rows[0].raw["USER ID"]).toBe("jdoe");
  });

  it("nullifies empty cells", () => {
    const csv = "USER ID,MAIL ID\njdoe,\n";
    const { rows } = parseExport(csv);
    expect(rows[0].fields.email).toBeNull();
  });
});
