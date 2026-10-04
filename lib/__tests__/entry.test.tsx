// The entry dialog of the Log screen: its pure helpers, and a server render of
// the component for each kind of entry (no browser needed).
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EMPTY_ENTRY_MESSAGE, EntryDialog, buildEntry, cellText, checkDraft, draftFrom, editedBefore, entryLabel, entrySlot, parseCell,
} from "@/components/EntryDialog";
import { DEFAULT_LIMITS } from "@/lib/params";
import type { LogEntry, Plant } from "@/lib/types";

const plant = (shiftsPerDay: 1 | 2 | 3): Plant => ({
  id: "p1", name: "Test STP", kind: "STP", location: "x", capacityKld: 100, technology: "MBBR",
  operatorCompany: "", consentNo: "", shiftsPerDay, limits: DEFAULT_LIMITS.STP,
});
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: "e1", plantId: "p1", date: "2026-09-12", shift: "A", time: null, operator: "Ravi", remarks: null,
  values: { phOutlet: 7.1, bodOutlet: 18, codOutlet: 90 }, pageId: "page-1",
  cellMeta: { phOutlet: { raw: "7.1", confidence: "high" }, bodOutlet: { raw: "1B", confidence: "low" } },
  edited: ["bodOutlet"], capturedAt: "2026-09-12T10:00:00.000Z", ...over,
});

describe("parseCell", () => {
  it("accepts plain decimals and blanks only", () => {
    expect(parseCell("")).toBe(null);
    expect(parseCell("   ")).toBe(null);
    expect(parseCell(" 7.1 ")).toBe(7.1);
    expect(parseCell("-5")).toBe(-5);
    expect(parseCell(".5")).toBe(0.5);
    expect(parseCell("5.")).toBe(5);
    for (const bad of ["abc", "1e3", "0x10", "Infinity", "NaN", "7,1", "7.1.2", "=1+1", "--5", "9".repeat(400)]) {
      expect(parseCell(bad), bad).toBe(undefined);
    }
    expect(parseCell(undefined as unknown as string)).toBe(null);
  });
  it("cellText pads to the register's decimals and survives junk", () => {
    expect(cellText("phOutlet", 7)).toBe("7.0");
    expect(cellText("phOutlet", 7.25)).toBe("7.25");
    expect(cellText("bodOutlet", 18)).toBe("18");
    expect(cellText("bodOutlet", NaN)).toBe("");
    expect(cellText("bodOutlet", "18")).toBe("");
    expect(cellText("bodOutlet", null)).toBe("");
    expect(cellText("energyKwh", 1e21)).toBe("1e+21");
  });
});

describe("entrySlot", () => {
  it("keys shift sheets on date + shift or time", () => {
    expect(entrySlot({ date: "2026-09-12", shift: "A", time: null }, 3)).toBe(entrySlot({ date: "2026-09-12", shift: "A", time: "08:00" }, 3));
    expect(entrySlot({ date: "2026-09-12", shift: "A", time: null }, 3)).not.toBe(entrySlot({ date: "2026-09-12", shift: "B", time: null }, 3));
    expect(entrySlot({ date: "2026-09-12", shift: null, time: "08:00" }, 3)).toBeTruthy();
    expect(entrySlot({ date: "2026-09-12", shift: null, time: null }, 3)).toBe(null);
  });
  it("keys a daily register on its date", () => {
    const a = entrySlot({ date: "2026-09-12", shift: null, time: null }, 1);
    expect(a).toBeTruthy();
    expect(entrySlot({ date: "2026-09-12", shift: null, time: null }, 1)).toBe(a);
    expect(entrySlot({ date: "2026-09-13", shift: null, time: null }, 1)).not.toBe(a);
  });
  it("never throws on damaged entries", () => {
    expect(entrySlot({}, 3)).toBe(null);
    expect(entrySlot({ date: "12/09/2026", shift: "A" }, 3)).toBe(null);
    expect(entrySlot({ date: "2026-02-30", shift: "A" }, 3)).toBe(null);
    expect(entrySlot({ date: 5, shift: {}, time: [] } as never, 1)).toBe(null);
    expect(entryLabel({})).toBe("no date");
    expect(entryLabel({ date: "2026-09-12", shift: "A" })).toMatch(/12 Sept? 2026, shift A/);
  });
});

describe("buildEntry", () => {
  const keys = ["phOutlet", "bodOutlet", "codOutlet", "tssOutlet"] as const;
  it("records the union of earlier and newly changed parameters", () => {
    const e = entry();
    const d = draftFrom(e, "2026-10-04");
    d.cells.phOutlet = "7.4";
    d.cells.tssOutlet = "22";
    const { entry: out, changed } = buildEntry(d, e, "p1", [...keys], "NOW", "new-id");
    expect(changed).toEqual(["phOutlet", "tssOutlet"]);
    expect(out.edited).toEqual(["phOutlet", "bodOutlet", "tssOutlet"]);
    expect(out.values).toEqual({ phOutlet: 7.4, bodOutlet: 18, codOutlet: 90, tssOutlet: 22 });
    expect(out.id).toBe("e1");
    expect(out.pageId).toBe("page-1");
    expect(out.capturedAt).toBe("2026-09-12T10:00:00.000Z");
    expect(out.cellMeta).toEqual(e.cellMeta);
  });
  it("does not count an untouched or re-typed equal value as changed", () => {
    const e = entry();
    const d = draftFrom(e, "2026-10-04");
    d.cells.phOutlet = "7.10";
    d.operator = "  Someone else ";
    const { entry: out, changed } = buildEntry(d, e, "p1", [...keys], "NOW", "x");
    expect(changed).toEqual([]);
    expect(out.edited).toEqual(["bodOutlet"]);
    expect(out.operator).toBe("Someone else");
  });
  it("clearing a value removes it and counts as a change", () => {
    const e = entry();
    const d = draftFrom(e, "2026-10-04");
    d.cells.codOutlet = "";
    const { entry: out, changed } = buildEntry(d, e, "p1", [...keys], "NOW", "x");
    expect(changed).toEqual(["codOutlet"]);
    expect("codOutlet" in out.values).toBe(false);
  });
  it("keeps values of parameters that are not in the form", () => {
    const e = entry({ values: { phOutlet: 7.1, energyKwh: 5000 } });
    const { entry: out } = buildEntry(draftFrom(e, "t"), e, "p1", ["phOutlet"], "NOW", "x");
    expect(out.values.energyKwh).toBe(5000);
  });
  it("survives an entry with no values, no edited list and junk inside", () => {
    const e = { id: "e9", plantId: "p1", date: "junk", pageId: null, capturedAt: "" } as unknown as LogEntry;
    const d = draftFrom(e, "2026-10-04");
    expect(d.date).toBe("");
    expect(d.cells).toEqual({});
    d.date = "2026-09-01";
    d.cells.phOutlet = "7";
    const { entry: out } = buildEntry(d, e, "p1", ["phOutlet"], "NOW", "x");
    expect(out.values).toEqual({ phOutlet: 7 });
    expect(out.edited).toEqual(["phOutlet"]);
    const junk = entry({ values: { phOutlet: NaN, bodOutlet: "12" as never, codOutlet: 90 }, edited: ["nope", "codOutlet", 4] as never });
    expect(editedBefore(junk)).toEqual(["codOutlet"]);
    const r = buildEntry(draftFrom(junk, "t"), junk, "p1", ["phOutlet", "bodOutlet", "codOutlet"], "NOW", "x");
    expect(r.entry.values).toEqual({ codOutlet: 90 });
    expect(r.changed).toEqual([]);
  });
  it("makes a hand-typed entry with no page and the time it was typed", () => {
    const d = draftFrom(null, "2026-10-04");
    d.cells.inletTotaliser = "123456";
    d.cells.limeKg = "0.25";
    const { entry: out } = buildEntry(d, null, "p1", ["inletTotaliser", "limeKg"], "2026-10-04T09:00:00.000Z", "e-new");
    expect(out).toEqual({
      id: "e-new", plantId: "p1", date: "2026-10-04", shift: null, time: null, operator: null, remarks: null,
      values: { inletTotaliser: 123456, limeKg: 0.25 }, pageId: null, edited: [], capturedAt: "2026-10-04T09:00:00.000Z",
    });
  });
});

describe("checkDraft", () => {
  const keys = ["phOutlet", "bodOutlet"] as const;
  const today = "2026-10-04";
  it("refuses a second entry for the same date and shift", () => {
    const a = entry({ id: "a" });
    const b = entry({ id: "b", shift: "B" });
    const d = draftFrom(b, today);
    expect(checkDraft(d, b, [a, b], 3, [...keys], today).errors).toEqual([]);
    d.shift = "A";
    const c = checkDraft(d, b, [a, b], 3, [...keys], today);
    expect(c.clash?.id).toBe("a");
    expect(c.errors.join(" ")).toMatch(/already has an entry/);
    // a new hand-typed entry for a taken slot
    const n = draftFrom(null, "2026-09-12");
    n.shift = "A";
    n.cells.phOutlet = "7";
    expect(checkDraft(n, null, [a, b], 3, [...keys], today).clash?.id).toBe("a");
    n.shift = "C";
    expect(checkDraft(n, null, [a, b], 3, [...keys], today).errors).toEqual([]);
  });
  it("refuses a second row for the same day of a daily register", () => {
    const a = entry({ id: "a", shift: null, time: null });
    const n = draftFrom(null, "2026-09-12");
    n.cells.phOutlet = "7";
    expect(checkDraft(n, null, [a], 1, [...keys], today).clash?.id).toBe("a");
    n.date = "2026-09-13";
    const ok = checkDraft(n, null, [a], 1, [...keys], today);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);
  });
  it("blocks bad numbers, dates and times; only warns on impossible values", () => {
    const e = entry();
    const d = draftFrom(e, today);
    d.cells.phOutlet = "71";
    let c = checkDraft(d, e, [e], 3, [...keys], today);
    expect(c.errors).toEqual([]);
    expect(c.impossible).toEqual(["phOutlet"]);
    expect(c.warnings.length).toBe(1);
    d.cells.phOutlet = "7..1";
    d.time = "25:00";
    d.date = "";
    c = checkDraft(d, e, [e], 3, [...keys], today);
    expect(c.invalid).toEqual(["phOutlet"]);
    expect(c.errors.length).toBe(3);
  });
  it("refuses an entry with nothing in it", () => {
    const n = draftFrom(null, today);
    expect(checkDraft(n, null, [], 1, [...keys], today).errors).toEqual([EMPTY_ENTRY_MESSAGE]);
    n.remarks = "Plant shut for power cut";
    expect(checkDraft(n, null, [], 1, [...keys], today).errors).toEqual([]);
  });
  it("tolerates damaged entries in the log", () => {
    const others = [null, {}, { id: "z", date: 5 }, entry({ id: "a" })] as unknown as LogEntry[];
    const n = draftFrom(null, "2026-09-12");
    n.shift = "A";
    n.cells.phOutlet = "7";
    expect(checkDraft(n, null, others, 3, [...keys], today).clash?.id).toBe("a");
  });
});

describe("EntryDialog renders without throwing", () => {
  const noop = () => {};
  const img = () => Promise.resolve(null);
  const render = (e: LogEntry | null, p: Plant, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(EntryDialog, {
      plant: p, entry: e, entries: e ? [e] : [], pages: [], flags: [], params: ["phOutlet", "bodOutlet"],
      getPageImage: img, onSave: noop, onDelete: noop, onClose: noop, ...extra,
    } as never));
  it("a normal page entry, with provenance and flags", () => {
    const e = entry();
    const html = render(e, plant(3), {
      pages: [{ id: "page-1", plantId: "p1", uploadedAt: "x", fileName: "IMG_<1>.jpg", imageDataUrl: "", model: "gemini-test", notes: ["blurred corner"], reviewedAt: null }],
      flags: [{ id: "f1", ruleId: "limit", category: "compliance", severity: "high", title: "T-FLAG", detail: "d", verify: "v", entryIds: ["e1"] },
              { id: "f2", ruleId: "limit", category: "compliance", severity: "high", title: "OTHER", detail: "d", verify: "v", entryIds: ["zz"] }],
    });
    expect(html).toContain("<dialog");
    expect(html).toContain("aria-labelledby");
    expect(html).toContain("IMG_&lt;1&gt;.jpg");
    expect(html).toContain("gemini-test");
    expect(html).toContain("T-FLAG");
    expect(html).not.toContain("OTHER");
    expect(html).toContain("Loading the photo");
    expect(html).toContain("1B");
    expect(html).toContain("reader unsure");
    expect(html).toContain("changed by a person");
    expect(html).toContain("Save changes");
  });
  it("an empty hand entry on a daily plant has no shift box", () => {
    const html = render(null, plant(1));
    expect(html).toContain("Add an entry by hand");
    expect(html).not.toContain(">Shift<");
    expect(html).not.toContain("Delete entry");
    expect(html).toContain("Add entry");
  });
  it("a three-shift plant gets the shift box", () => {
    expect(render(null, plant(3))).toMatch(/Shift<select/);
  });
  it("a damaged entry", () => {
    const e = { id: "bad", date: "31/02", shift: "Q", values: undefined, cellMeta: { phOutlet: null, mlss: { raw: 5 } }, edited: "x", pageId: 7, capturedAt: null } as unknown as LogEntry;
    const html = render(e, plant(2), { askDelete: true, flags: [{ id: "f", entryIds: null }, null] });
    expect(html).toContain("not a real calendar date");
    expect(html).toContain("not recorded");
    expect(html).toContain("Typed in by hand");
    expect(html).toContain("Keep it");
  });
  it("generated sample entries are labelled as generated", () => {
    const html = render(entry({ pageId: "seed", cellMeta: undefined, edited: undefined }), plant(3));
    expect(html).toContain("Generated sample history");
    expect(html).not.toContain("Loading the photo");
  });
});
