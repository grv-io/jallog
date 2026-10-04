// Ordering and CSV export of the Log screen.
import { describe, expect, it } from "vitest";
import * as m from "@/app/log/csv";
import { COLUMN_ORDER } from "@/lib/params";
import { PARAM_KEYS } from "@/lib/types";
import type { LogEntry } from "@/lib/types";

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: "e1", plantId: "p1", date: "2026-09-12", shift: "A", time: null, operator: "Ravi", remarks: null,
  values: { phOutlet: 7.1, bodOutlet: 18, codOutlet: 90 }, pageId: "page-1",
  cellMeta: { phOutlet: { raw: "7.1", confidence: "high" }, bodOutlet: { raw: "1B", confidence: "low" } },
  edited: ["bodOutlet"], capturedAt: "2026-09-12T10:00:00.000Z", ...over,
});

describe("column order", () => {
  it("lists every parameter exactly once", () => {
    expect([...COLUMN_ORDER].sort()).toEqual([...PARAM_KEYS].sort());
    expect(new Set(COLUMN_ORDER).size).toBe(PARAM_KEYS.length);
  });
});

describe("CSV export (app/log/csv.ts)", () => {
  it("starts the file with a UTF-8 byte order mark", () => {
    expect(m.UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(m.UTF8_BOM).toHaveLength(1);
  });
  it("neutralises formula cells but leaves numbers alone", () => {
    expect(m.csvText("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(m.csvText("+91 98")).toBe("'+91 98");
    expect(m.csvText("-low")).toBe("'-low");
    expect(m.csvText("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(m.csvText("\t=1")).toBe("'\t=1");
    expect(m.csvText('=1,"x"')).toBe(`"'=1,""x"""`);
    expect(m.csvText("line1\nline2")).toBe('"line1\nline2"');
    expect(m.csvText("plain")).toBe("plain");
    expect(m.csvText(null)).toBe("");
    expect(m.csvText(undefined)).toBe("");
    expect(m.csvText({})).toBe("");
    expect(m.csvNumber(-5)).toBe("-5");
    expect(m.csvNumber(NaN)).toBe("");
    expect(m.csvNumber("=1")).toBe("");
  });
  it("writes every parameter that has data, and only those", () => {
    const rows = [
      entry({ id: "b", date: "2026-09-13", shift: null, values: { inletTotaliser: 1200, sludgeKg: 4.5 }, operator: "=cmd|' /C calc'!A0", remarks: 'said "ok", left', pageId: null, edited: undefined }),
      entry({ id: "a", date: "2026-09-12", values: { phOutlet: 7.1, limeKg: 0.25 }, pageId: "page-1" }),
      { id: "c" } as unknown as LogEntry,
    ];
    const csv: string = m.toCsv(rows, [{ id: "page-1", fileName: "@evil.jpg" }, null] as never);
    const lines = csv.split("\r\n");
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe("date,shift,time,operator,phOutlet,inletTotaliser (m³),limeKg (kg),sludgeKg (kg),remarks,source,changed_by_person,digitised_at");
    expect(lines[1]).toBe("2026-09-12,A,,Ravi,7.1,,0.25,,,'@evil.jpg,bodOutlet,2026-09-12T10:00:00.000Z");
    expect(lines[2]).toBe(`2026-09-13,,,'=cmd|' /C calc'!A0,,1200,,4.5,"said ""ok"", left",typed by hand,,2026-09-12T10:00:00.000Z`);
    expect(lines[3]).toBe(",,,,,,,,,typed by hand,,");
    expect(m.toCsv([], [])).toBe("date,shift,time,operator,remarks,source,changed_by_person,digitised_at");
  });
  it("gives a safe file name for any plant name", () => {
    expect(m.csvFileName("Green Valley STP", "2026-10-04")).toBe("green-valley-stp-log-2026-10-04.csv");
    expect(m.csvFileName("", "2026-10-04")).toBe("plant-log-2026-10-04.csv");
    expect(m.csvFileName(undefined, "2026-10-04")).toBe("plant-log-2026-10-04.csv");
    expect(m.csvFileName("../../etc/passwd", "2026-10-04")).toBe("etc-passwd-log-2026-10-04.csv");
    expect(m.csvFileName('<>:"/\\|?*', "2026-10-04")).toBe("plant-log-2026-10-04.csv");
    const hindi = m.csvFileName("जयपुर एसटीपी", "2026-10-04");
    expect(hindi).toBe("जयपुर-एसटीपी-log-2026-10-04.csv");
    expect(m.csvFileName("x".repeat(500), "2026-10-04").length).toBeLessThan(80);
    expect(m.csvFileName("a\u202Eb\u0000c", "d")).toBe("a-b-c-log-d.csv");
  });
  it("orders damaged entries without throwing, undated last", () => {
    const list = [{ id: "u" }, entry({ id: "2", date: "2026-09-13" }), entry({ id: "1", shift: "B" }), entry({ id: "0" }), { id: "v", date: 7, shift: 3 }] as LogEntry[];
    expect([...list].sort(m.byRegisterOrder).map((e) => e.id)).toEqual(["0", "1", "2", "u", "v"]);
  });
  it("sorts and exports 5,000 entries quickly", () => {
    const many: LogEntry[] = [];
    for (let i = 0; i < 5000; i++) {
      const d = new Date(Date.UTC(2020, 0, 1 + Math.floor(i / 3))).toISOString().slice(0, 10);
      many.push(entry({ id: `e${i}`, date: d, shift: (["A", "B", "C"] as const)[i % 3] }));
    }
    const t = Date.now();
    const csv: string = m.toCsv(many, []);
    const ms = Date.now() - t;
    expect(csv.split("\r\n").length).toBe(5001);
    expect(ms, `took ${ms} ms`).toBeLessThan(2000);
  });
});
