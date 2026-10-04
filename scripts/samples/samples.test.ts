import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks, STEP_MIN_N, TWIN_MIN_N } from "../../lib/checks";
import { buildDailySeed } from "../../lib/seed";
import type { LogEntry } from "../../lib/types";

const truth = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "public", "samples", "truth.json"), "utf8"));
type Row = { date: string; operator: string; remarks: string | null; cellMeta: object; values: Record<string, number> };
const page = (f: string) => truth.pages.find((p: { file: string }) => p.file === f);

describe("sample pages", () => {
  it("use plainly invented plant names, not real hospitals", () => {
    const text = JSON.stringify(truth.pages.map((p: { title: string; description: string }) => [p.title, p.description]));
    expect(text).not.toMatch(/Sunrise|City Care/i);
  });

  it("page 4 carries inlet = outlet and identical energy steps on enough rows", () => {
    const rows = page("page-4.jpg").rows;
    const twins = rows.filter((r: Row) => r.values.inletTotaliser === r.values.outletTotaliser).length;
    expect(twins).toBeGreaterThanOrEqual(TWIN_MIN_N);
    const rises = rows.slice(1).map((r: Row, i: number) => r.values.energyKwh - rows[i].values.energyKwh);
    let best = 1, run = 1;
    for (let i = 1; i < rises.length; i++) { run = rises[i] === rises[i - 1] ? run + 1 : 1; best = Math.max(best, run); }
    expect(best).toBeGreaterThanOrEqual(STEP_MIN_N);
  });

  it("capturing page 4 on the daily sample plant raises a new identical-steps flag", () => {
    const seed = buildDailySeed("2026-09-20");
    const before = runChecks(seed.plant, seed.entries).flags.filter((f) => f.ruleId === "step").length;
    const added: LogEntry[] = page("page-4.jpg").rows.map((r: Row, i: number) => ({
      id: `p4-${i}`, plantId: seed.plant.id, date: r.date, shift: null, time: null, operator: r.operator,
      values: r.values, remarks: r.remarks, pageId: "page4", capturedAt: "2026-10-05T06:00:00.000Z",
    }));
    const after = runChecks(seed.plant, [...seed.entries, ...added]).flags.filter((f) => f.ruleId === "step");
    expect(after.length, JSON.stringify(after.map((f) => f.title))).toBeGreaterThan(before);
    expect(after.some((f) => f.entryIds.some((id) => id.startsWith("p4-")))).toBe(true);
  });

  it("pages 1 to 3 keep one recorded reader answer, labelled, apart from the truth rows", () => {
    for (const f of ["page-1.jpg", "page-2.jpg", "page-3.jpg"]) {
      const rec = page(f).recorded;
      expect(rec.label, f).toMatch(/^Reading recorded on 4 Oct 2026 from gemini/);
      expect(rec.rows.length, f).toBe(page(f).rows.length);
    }
    const lows = page("page-2.jpg").recorded.rows.flatMap((r: Row) => Object.values(r.cellMeta) as { confidence: string }[]).filter((m: { confidence: string }) => m.confidence === "low");
    expect(lows.length).toBeGreaterThan(0);
    expect(page("page-2.jpg").rows[0].cellMeta).toEqual({});
  });
});
