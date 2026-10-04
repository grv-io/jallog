// Round-1 review findings against the Log screen and its entry dialog:
// entries that share a date, an entry changed or deleted in another tab while
// its dialog is open, and how flags are marked in the table.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EntryDialog, NO_SLOT_MESSAGE, buildEntry, checkDraft, draftFrom, flagMarks, flagsBehind, rebaseDraft, sameDraft,
} from "@/components/EntryDialog";
import { logLink } from "@/components/FlagList";
import { DEFAULT_LIMITS } from "@/lib/params";
import { ops } from "@/lib/store";
import type { State } from "@/lib/store";
import type { Flag, LogEntry, Plant } from "@/lib/types";

const plant = (shiftsPerDay: 1 | 2 | 3): Plant => ({
  id: "p1", name: "Test STP", kind: "STP", location: "x", capacityKld: 50, technology: "MBBR",
  operatorCompany: "", consentNo: "", shiftsPerDay, limits: DEFAULT_LIMITS.STP,
});
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: "e1", plantId: "p1", date: "2026-09-20", shift: null, time: null, operator: null, remarks: null,
  values: {}, pageId: null, edited: [], capturedAt: "2026-09-21T10:00:00.000Z", ...over,
});
const today = "2026-10-04";

describe("an entry that shares its date with another (finding 1)", () => {
  // Two facing pages of a daily register saved while the plant still said
  // 3 shifts a day: two entries per date, neither with a shift or time.
  const meters = entry({ id: "m20", values: { inletTotaliser: 45210 } });
  const dosing = entry({ id: "d20", values: { limeKg: 0.5 } });
  const next = entry({ id: "m21", date: "2026-09-21", values: { inletTotaliser: 45290 } });
  const log = [meters, dosing, next];
  const keys = ["inletTotaliser", "limeKg"] as const;

  it("can be corrected once the plant is set to one row a day", () => {
    for (const e of [meters, dosing]) {
      const d = draftFrom(e, today);
      if (e === dosing) d.cells.limeKg = "0.7";
      else d.cells.inletTotaliser = "45215";
      const c = checkDraft(d, e, log, 1, [...keys], today);
      expect(c.errors, JSON.stringify(c)).toEqual([]);
      expect(c.clash).toBe(null);
      expect(c.sharing).toBe(1);
      expect(c.warnings.join(" ")).toMatch(/One other entry is also saved for 20 Sep 2026\./);
      expect(c.warnings.join(" ")).toMatch(/changes only this entry/);
    }
  });
  it("still refuses to move an entry onto a date that is taken", () => {
    const d = draftFrom(dosing, today);
    d.date = "2026-09-21";
    const c = checkDraft(d, dosing, log, 1, [...keys], today);
    expect(c.clash?.id).toBe("m21");
    expect(c.errors.join(" ")).toMatch(/already has an entry for 21 Sep 2026/);
    // and moving it to a free date is fine, with no warning about sharing
    d.date = "2026-09-22";
    const ok = checkDraft(d, dosing, log, 1, [...keys], today);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);
  });
  it("still refuses a new hand-typed entry for a date that is taken", () => {
    const n = draftFrom(null, "2026-09-20");
    n.cells.limeKg = "1";
    const c = checkDraft(n, null, log, 1, [...keys], today);
    expect(c.clash).not.toBe(null);
    expect(c.errors.length).toBe(1);
  });
  it("a three-shift day switched to one row a day: each of the three can be corrected", () => {
    const abc = (["A", "B", "C"] as const).map((s) => entry({ id: `s${s}`, shift: s, values: { phOutlet: 7.3 } }));
    for (const e of abc) {
      const d = draftFrom(e, today);
      d.cells.phOutlet = "7.5";
      const c = checkDraft(d, e, abc, 1, ["phOutlet"], today);
      expect(c.errors, e.id).toEqual([]);
      expect(c.sharing).toBe(2);
      expect(c.warnings.join(" ")).toMatch(/2 other entries are also saved for 20 Sep 2026\./);
    }
  });
  it("two stored entries with the same date and shift can each be corrected", () => {
    const x6 = entry({ id: "x6", shift: "A", values: { phOutlet: 7.1 } });
    const x7 = entry({ id: "x7", shift: "A", values: { phOutlet: 7.4 } });
    const d = draftFrom(x7, today);
    d.remarks = "checked against the register";
    const c = checkDraft(d, x7, [x6, x7], 3, ["phOutlet"], today);
    expect(c.errors).toEqual([]);
    expect(c.warnings.join(" ")).toMatch(/also saved for 20 Sep 2026, shift A\./);
    // changing only the time keeps the slot (date + shift), so it still saves
    d.time = "08:00";
    expect(checkDraft(d, x7, [x6, x7], 3, ["phOutlet"], today).errors).toEqual([]);
    // moving it to shift B, which is free, saves without the sharing warning
    d.shift = "B";
    const moved = checkDraft(d, x7, [x6, x7], 3, ["phOutlet"], today);
    expect(moved.errors).toEqual([]);
    expect(moved.sharing).toBe(0);
  });
  it("an entry stored with a bad date cannot be given a date that is taken", () => {
    const bad = entry({ id: "bad", date: "31/02", values: { limeKg: 1 } });
    const d = draftFrom(bad, today);
    d.date = "2026-09-20";
    expect(checkDraft(d, bad, [...log, bad], 1, [...keys], today).clash).not.toBe(null);
  });
});

describe("undoing the delete of an entry that shared its date (follows from finding 1)", () => {
  // The Log's Undo puts such an entry back in two steps (see restore() in
  // app/log/page.tsx): added without its date, so the store's replace-the-slot
  // rule has nothing to replace, then given its own fields back. This pins the
  // two store behaviours that relies on.
  const meters = entry({ id: "m20", values: { inletTotaliser: 45210 } });
  const dosing = entry({ id: "d20", values: { limeKg: 0.5 }, remarks: "bag opened" });
  const state = (entries: LogEntry[]): State => ({ plant: plant(1), entries, pages: [] });

  it("a plain add would swallow the entry that stayed", () => {
    const after = ops.addEntries(null, [dosing])(state([meters]));
    expect(after.entries.map((e) => e.id)).toEqual(["d20"]);
  });
  it("the two-step restore leaves both entries exactly as they were", () => {
    const parked = ops.addEntries(null, [{ ...dosing, date: "" }])(state([meters]));
    expect(parked.entries.map((e) => e.id).sort()).toEqual(["d20", "m20"]);
    const back = ops.updateEntry(dosing)(parked);
    expect(back.entries.find((e) => e.id === "m20")).toEqual(meters);
    expect(back.entries.find((e) => e.id === "d20")).toEqual(dosing);
    expect(back.entries.length).toBe(2);
  });
  it("the same holds for two entries of one shift on a shift plant", () => {
    const a = entry({ id: "x6", shift: "A", values: { phOutlet: 7.1 } });
    const b = entry({ id: "x7", shift: "A", values: { phOutlet: 7.4 } });
    const s3 = (entries: LogEntry[]): State => ({ plant: plant(3), entries, pages: [] });
    const back = ops.updateEntry(b)(ops.addEntries(null, [{ ...b, date: "" }])(s3([a])));
    expect(back.entries).toEqual([a, b]);
  });
});

describe("an entry changed in another tab while its dialog is open (finding 2)", () => {
  const keys = ["phOutlet", "bodOutlet"] as const;
  const opened = entry({ id: "s15", date: "2026-09-15", shift: "A", operator: "Ravi", values: { phOutlet: 7.3, bodOutlet: 18 }, pageId: "seed" });
  // What tab A saved while tab B's dialog was open.
  const saved: LogEntry = { ...opened, values: { phOutlet: 9.9, bodOutlet: 18 }, edited: ["phOutlet"] };

  it("a save that touched only the remark keeps the other tab's correction", () => {
    const initial = draftFrom(opened, today);
    const stale = { ...initial, remarks: "sampled late" };
    const { entry: out, changed } = buildEntry(stale, saved, "p1", [...keys], "NOW", "x", initial);
    expect(out.values.phOutlet).toBe(9.9);
    expect(out.remarks).toBe("sampled late");
    expect(changed).toEqual([]);
    expect(out.edited).toEqual(["phOutlet"]);
  });
  it("a box the person did type in wins over the other tab's value", () => {
    const initial = draftFrom(opened, today);
    const stale = { ...initial, cells: { ...initial.cells, phOutlet: "7.5" } };
    const { entry: out, changed } = buildEntry(stale, saved, "p1", [...keys], "NOW", "x", initial);
    expect(out.values.phOutlet).toBe(7.5);
    expect(changed).toEqual(["phOutlet"]);
  });
  it("untouched date, shift, operator and remarks follow the saved entry too", () => {
    const initial = draftFrom(opened, today);
    const elsewhere: LogEntry = { ...opened, shift: "B", operator: "Meena", remarks: "moved to B", values: { bodOutlet: 18 } };
    const stale = { ...initial, cells: { ...initial.cells, bodOutlet: "21" } };
    const { entry: out, changed } = buildEntry(stale, elsewhere, "p1", [...keys], "NOW", "x", initial);
    expect(out.shift).toBe("B");
    expect(out.operator).toBe("Meena");
    expect(out.remarks).toBe("moved to B");
    // the other tab cleared pH; this form never touched it, so it stays cleared
    expect("phOutlet" in out.values).toBe(false);
    expect(out.values.bodOutlet).toBe(21);
    expect(changed).toEqual(["bodOutlet"]);
  });
  it("rebaseDraft keeps typed text and refreshes the rest", () => {
    const initial = draftFrom(opened, today);
    const mine = { ...initial, operator: "R. Kumar", cells: { ...initial.cells, bodOutlet: "" } };
    const now = draftFrom(saved, today);
    const out = rebaseDraft(mine, initial, now);
    expect(out.operator).toBe("R. Kumar");
    expect(out.cells.bodOutlet).toBe("");
    expect(out.cells.phOutlet).toBe("9.9");
    expect(sameDraft(out, now)).toBe(false);
    // nothing typed: the form simply becomes the saved entry
    expect(sameDraft(rebaseDraft(initial, initial, now), now)).toBe(true);
  });
  it("sameDraft treats a box cleared again as untouched", () => {
    const a = draftFrom(opened, today);
    const b = { ...a, cells: { ...a.cells, tssOutlet: "" } };
    expect(sameDraft(a, b)).toBe(true);
    expect(sameDraft(a, { ...a, remarks: "x" })).toBe(false);
    expect(sameDraft(a, { ...a, cells: { ...a.cells, phOutlet: "7.30" } })).toBe(false);
  });
  it("without the form's starting text, buildEntry behaves as before", () => {
    const d = draftFrom(saved, today);
    d.cells.bodOutlet = "20";
    const { entry: out, changed } = buildEntry(d, saved, "p1", [...keys], "NOW", "x");
    expect(out.values).toEqual({ phOutlet: 9.9, bodOutlet: 20 });
    expect(changed).toEqual(["bodOutlet"]);
  });
});

describe("the dialog's wording (findings 2, 4 and 6)", () => {
  const noop = () => {};
  const img = () => Promise.resolve(null);
  const render = (e: LogEntry | null, p: Plant, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(EntryDialog, {
      plant: p, entry: e, entries: e ? [e] : [], pages: [], flags: [], params: ["phOutlet", "bodOutlet"],
      getPageImage: img, onSave: noop, onDelete: noop, onClose: noop, ...extra,
    } as never));

  it("an empty add-by-hand form does not open on a warning", () => {
    const html = render(null, plant(3));
    expect(html).not.toContain("notice warn");
    expect(html).not.toContain(NO_SLOT_MESSAGE);
    // the same advice sits under the Shift box instead
    expect(html).toMatch(/Pick the shift/);
    // a daily register has no shift to pick
    expect(render(null, plant(1))).not.toMatch(/Pick the shift/);
  });
  it("checkDraft still reports a missing shift, so an existing entry that loses its shift is warned about", () => {
    const e = entry({ shift: "A", values: { phOutlet: 7 } });
    const d = draftFrom(e, today);
    d.shift = "";
    expect(checkDraft(d, e, [e], 3, ["phOutlet"], today).warnings).toContain(NO_SLOT_MESSAGE);
  });
  it("says None, not 'No reading' or 'No cell'", () => {
    const html = render(entry({ shift: "A", values: { phOutlet: 7 }, pageId: "page-9", edited: [] }), plant(3));
    expect(html).not.toContain("No reading");
    expect(html).not.toContain("No cell");
    expect(html).toMatch(/Reader unsure of<\/dt><dd>None<\/dd>/);
    expect(html).toMatch(/Changed by a person<\/dt><dd>None<\/dd>/);
  });
  it("an entry deleted in another tab stays open, says so, and offers to put it back", () => {
    const e = entry({ shift: "A", values: { phOutlet: 7 } });
    const html = render(e, plant(3), { gone: true, entries: [] });
    expect(html).toContain("no longer in the log");
    expect(html).toContain("Put entry back");
    expect(html).not.toContain("Delete entry");
  });
  it("the footer buttons keep their full names for a screen reader", () => {
    const html = render(entry({ shift: "A", values: { phOutlet: 7 } }), plant(3));
    expect(html).toContain('aria-label="Save changes"');
    expect(html).toContain('aria-label="Delete entry"');
  });
});

describe("flag marks in the log table (finding 5)", () => {
  const flag = (over: Partial<Flag>): Flag => ({
    id: "f", ruleId: "r", category: "integrity", severity: "medium", title: "T", detail: "d", verify: "v", entryIds: [], ...over,
  });
  it("keeps the worst severity and every title per cell, and whole-entry flags apart", () => {
    const { marks, flaggedIds } = flagMarks([
      flag({ id: "a", param: "bodOutlet", severity: "low", title: "BOD mostly ends in 0 or 5", entryIds: ["e1", "e2"] }),
      flag({ id: "b", param: "bodOutlet", severity: "high", title: "Outlet BOD outside consent limit", entryIds: ["e1"] }),
      flag({ id: "c", severity: "medium", title: "Several readings repeated unchanged", entryIds: ["e1", "e3", "e3"] }),
      flag({ id: "d", severity: "medium", title: "Several readings repeated unchanged", entryIds: ["e3"] }),
    ]);
    expect(marks.get("e1|bodOutlet")).toEqual({ severity: "high", titles: ["BOD mostly ends in 0 or 5", "Outlet BOD outside consent limit"] });
    expect(marks.get("e2|bodOutlet")?.severity).toBe("low");
    expect(marks.get("e1|*")).toEqual({ severity: "medium", titles: ["Several readings repeated unchanged"] });
    expect(marks.get("e3|*")?.titles).toEqual(["Several readings repeated unchanged"]);
    expect([...flaggedIds].sort()).toEqual(["e1", "e2", "e3"]);
  });
  it("survives damaged flags", () => {
    const { marks, flaggedIds } = flagMarks([
      null, 5, {}, { entryIds: "e1" }, { entryIds: [null, 7, "", "e9"], severity: "weird", title: { not: "text" }, param: "notAParam" },
    ] as never);
    expect([...flaggedIds]).toEqual(["e9"]);
    expect(marks.get("e9|*")).toEqual({ severity: "low", titles: [] });
    expect(flagMarks(undefined as never).marks.size).toBe(0);
  });
  it("names the flag a /log?entry=... link came from", () => {
    const repeated = flag({ id: "rep", title: "Several readings repeated unchanged", entryIds: ["e1", "e2", "e3"] });
    const limit = flag({ id: "lim", title: "Outlet BOD outside consent limit", param: "bodOutlet", entryIds: ["e2"] });
    const other = flag({ id: "oth", title: "Outlet pH outside consent limit", param: "phOutlet", entryIds: ["e2"] });
    const all = [repeated, limit, other, null] as Flag[];
    const idsOf = (href: string) => new URLSearchParams(href.split("?")[1]).getAll("entry");
    expect(flagsBehind(all, idsOf(logLink(repeated.entryIds)!.href), null).map((f) => f.id)).toEqual(["rep"]);
    // two flags on the same single entry: both are named
    expect(flagsBehind(all, ["e2"], null).map((f) => f.id)).toEqual(["lim", "oth"]);
    // an explicit flag id in the link wins
    expect(flagsBehind(all, ["e2"], "oth").map((f) => f.id)).toEqual(["oth"]);
    // an id that no longer exists falls back to matching the entries
    expect(flagsBehind(all, ["e2"], "gone").map((f) => f.id)).toEqual(["lim", "oth"]);
    // a hand-made link names nothing
    expect(flagsBehind(all, ["e1", "e2"], null)).toEqual([]);
    expect(flagsBehind(all, [], null)).toEqual([]);
    // a flag with more entries than a link carries is still recognised by its link
    const many = flag({ id: "many", title: "Readings mostly end in 0 or 5", entryIds: Array.from({ length: 90 }, (_, i) => `x${i}`) });
    expect(flagsBehind([many], idsOf(logLink(many.entryIds)!.href), null).map((f) => f.id)).toEqual(["many"]);
  });
});
