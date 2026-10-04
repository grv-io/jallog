import { describe, expect, it } from "vitest";
import { buildSeed } from "../seed";
import {
  EMPTY,
  STORAGE_KEYS,
  addDays,
  createVault,
  daysBetween,
  demoKindOf,
  demoState,
  fillBlankDates,
  formatDate,
  formatDateTime,
  isIsoDate,
  makeBackup,
  mergeEntries,
  ops,
  readBackup,
  registerKind,
  sanitizeState,
  saveImpact,
  slotKey,
  sortEntries,
} from "../store";
import type { KV, State, Wire } from "../store";
import type { LogEntry, LogPage, Plant } from "../types";

// ---------------------------------------------------------------- fixtures

function plant(over: Partial<Plant> = {}): Plant {
  return {
    id: "p1", name: "Test STP", kind: "STP", location: "", capacityKld: 100, technology: "MBBR",
    operatorCompany: "", consentNo: "", shiftsPerDay: 3, limits: { bodOutlet: { max: 30 } }, ...over,
  };
}

function entry(id: string, over: Partial<LogEntry> = {}): LogEntry {
  return {
    id, plantId: "p1", date: "2026-09-01", shift: null, time: null, operator: null,
    values: { phOutlet: 7.2 }, remarks: null, pageId: null, capturedAt: "2026-09-01T10:00:00.000Z", ...over,
  };
}

function page(id: string, photo = "data:image/jpeg;base64,AAAA"): LogPage {
  return { id, plantId: "p1", uploadedAt: "2026-09-01T10:00:00.000Z", fileName: `${id}.jpg`, imageDataUrl: photo, model: "test", notes: [], reviewedAt: null };
}

// One browser's storage, shared by every "tab" opened on it. Values are
// cloned on the way in and out, as IndexedDB does.
function browser() {
  const data = new Map<string, unknown>();
  const clone = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));
  const subs = new Set<(msg: unknown) => void>();

  function tab() {
    const ctl: { failWrites: boolean; failReads: boolean; writes: number; refuse: ((key: string) => boolean) | null } =
      { failWrites: false, failReads: false, writes: 0, refuse: null };
    const kv: KV = {
      async get(k) {
        if (ctl.failReads) throw new Error("read refused");
        return clone(data.get(k));
      },
      async set(k, v) {
        if (ctl.failWrites || ctl.refuse?.(k)) throw new Error("quota");
        ctl.writes++;
        data.set(k, clone(v));
      },
      async update(k, fn) {
        if (ctl.failWrites) throw new Error("quota");
        ctl.writes++;
        data.set(k, clone(fn(clone(data.get(k)))));
      },
      async keys() {
        return [...data.keys()];
      },
      async delMany(ks) {
        if (ctl.failWrites) throw new Error("quota");
        for (const k of ks) data.delete(k);
      },
    };
    let mine: ((msg: unknown) => void) | null = null;
    const wire: Wire = {
      post: (msg) => subs.forEach((fn) => { if (fn !== mine) setTimeout(() => fn(clone(msg)), 0); }),
      listen: (fn) => { mine = fn; subs.add(fn); },
      close: () => { if (mine) subs.delete(mine); },
    };
    const vault = createVault(kv, () => wire);
    const stop = vault.start();
    return { vault, ctl, stop, state: () => vault.getSnapshot().state };
  }

  return { data, tab, stored: () => data.get(STORAGE_KEYS.state) as (State & { rev: number }) | undefined };
}

// Lets queued storage jobs and cross-tab messages run to completion.
async function settle(...tabs: { vault: { idle(): Promise<void> } }[]) {
  for (let i = 0; i < 6; i++) {
    for (const t of tabs) await t.vault.idle();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const ids = (s: { entries: LogEntry[] }) => s.entries.map((e) => e.id).sort();

// ------------------------------------------------------------------- dates

describe("date helpers", () => {
  it("accepts only real calendar dates in YYYY-MM-DD", () => {
    expect(isIsoDate("2026-09-30")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    for (const bad of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-9-1", "30-09-2026", "", " 2026-09-30", "0026-09-30", null, undefined, 20260930, {}]) {
      expect(isIsoDate(bad), `isIsoDate(${JSON.stringify(bad)})`).toBe(false);
    }
  });

  it("adds days across month and year ends and leaves bad input alone", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-09-30", 0)).toBe("2026-09-30");
    expect(addDays("not a date", 3)).toBe("not a date");
    expect(addDays("2026-09-30", NaN)).toBe("2026-09-30");
    expect(addDays("9999-12-31", 1)).toBe("9999-12-31");
  });

  it("counts whole days, and gives NaN rather than a number for a bad date", () => {
    expect(daysBetween("2026-09-01", "2026-09-30")).toBe(29);
    expect(daysBetween("2026-09-30", "2026-09-01")).toBe(-29);
    expect(daysBetween("2026-09-01", "2026-09-01")).toBe(0);
    expect(daysBetween("", "2026-09-01")).toBeNaN();
    expect(daysBetween("2026-09-01", "2026-02-30")).toBeNaN();
  });

  it("formats a date and never throws on a bad one", () => {
    expect(formatDate("2026-09-05")).toMatch(/5/);
    expect(formatDate("2026-09-05")).toMatch(/Sep/);
    expect(formatDate("")).toBe("no date");
    expect(formatDate("yesterday")).toBe("yesterday");
    expect(formatDate(undefined as unknown as string)).toBe("no date");
  });

  it("writes dates the same way in every browser", () => {
    expect(formatDate("2026-09-05")).toBe("5 Sep");
    expect(formatDate("2026-09-05", { day: "numeric", month: "short", year: "numeric" })).toBe("5 Sep 2026");
    expect(formatDate("2026-09-05", { day: "numeric", month: "short", year: "2-digit" })).toBe("5 Sep 26");
    expect(formatDate("2026-09-01", { month: "long", year: "numeric" })).toBe("September 2026");
    expect(formatDate("2026-09-05", {})).toBe("2026-09-05");
    // a moment is shown in the device's own time zone
    const local = new Date(2026, 8, 5, 18, 5).toISOString();
    expect(formatDateTime(local)).toBe("5 Sep 2026, 18:05");
    for (const bad of ["", "soon", null, undefined, 5, {}]) expect(formatDateTime(bad)).toBe("");
  });

  it("sorts by date, then shift, then time, without touching the input", () => {
    const list = [
      entry("d", { date: "2026-09-02", shift: "A" }),
      entry("c", { date: "2026-09-01", shift: null, time: "20:00" }),
      entry("b", { date: "2026-09-01", shift: "C" }),
      entry("a", { date: "2026-09-01", shift: "A" }),
      entry("e", { date: "2026-09-01", shift: null, time: "08:00" }),
    ];
    expect(sortEntries(list).map((e) => e.id)).toEqual(["a", "b", "e", "c", "d"]);
    expect(list[0].id).toBe("d");
    const odd = [entry("x", { date: undefined as unknown as string }), entry("y")];
    expect(() => sortEntries(odd)).not.toThrow();
    expect(sortEntries(undefined as unknown as LogEntry[])).toEqual([]);
  });
});

describe("fillBlankDates", () => {
  const row = (date: string, shift: "A" | "B" | "C" | "" = "", time = "") => ({ date, shift, time });

  it("daily register: one day per row from the start date", () => {
    const out = fillBlankDates([row(""), row(""), row("")], "2026-09-29", 1);
    expect(out.map((r) => r.date)).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });

  it("daily register: a dated row re-anchors the count", () => {
    const out = fillBlankDates([row(""), row("2026-09-10"), row(""), row("")], "2026-09-01", 1);
    expect(out.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-10", "2026-09-11", "2026-09-12"]);
  });

  it("shift register: the date moves on when the shift letter starts again", () => {
    const out = fillBlankDates([row("", "A"), row("", "B"), row("", "C"), row("", "A"), row("", "B")], "2026-09-28", 3);
    expect(out.map((r) => r.date)).toEqual(["2026-09-28", "2026-09-28", "2026-09-28", "2026-09-29", "2026-09-29"]);
  });

  it("clock-time register: the date moves on when the time goes back", () => {
    const out = fillBlankDates([row("", "", "08:00"), row("", "", "20:00"), row("", "", "08:00")], "2026-09-29", 2);
    expect(out.map((r) => r.date)).toEqual(["2026-09-29", "2026-09-29", "2026-09-30"]);
  });

  it("rows with neither shift nor time stay on the same day in a shift register", () => {
    expect(fillBlankDates([row(""), row("")], "2026-09-29", 3).map((r) => r.date)).toEqual(["2026-09-29", "2026-09-29"]);
  });

  it("does nothing without a usable start date, keeps valid dates, and does not mutate", () => {
    const rows = [row(""), row("2026-09-02")];
    const out = fillBlankDates(rows, "soon", 1);
    expect(out.map((r) => r.date)).toEqual(["", "2026-09-02"]);
    expect(rows[0].date).toBe("");
    expect(fillBlankDates([], "2026-09-01", 1)).toEqual([]);
  });
});

// ------------------------------------------------------------------- slots

describe("slotKey", () => {
  it("daily register: the date alone, whatever shift or time the row carries", () => {
    expect(slotKey({ date: "2026-09-01", shift: null, time: null }, 1)).toBe("2026-09-01");
    expect(slotKey({ date: "2026-09-01", shift: "B", time: "14:00" }, 1)).toBe("2026-09-01");
  });

  it("shift register: date and shift letter, or date and clock time", () => {
    expect(slotKey({ date: "2026-09-01", shift: "B", time: null }, 3)).toBe("2026-09-01|B");
    expect(slotKey({ date: "2026-09-01", shift: "B", time: "14:00" }, 3)).toBe("2026-09-01|B");
    expect(slotKey({ date: "2026-09-01", shift: null, time: "08:00" }, 2)).toBe("2026-09-01|08:00");
  });

  it("null when the row cannot be placed", () => {
    expect(slotKey({ date: "2026-09-01", shift: null, time: null }, 3)).toBeNull();
    expect(slotKey({ date: "2026-09-01", shift: null, time: null }, undefined)).toBeNull();
    expect(slotKey({ date: "", shift: "A", time: null }, 3)).toBeNull();
    expect(slotKey({ date: "2026-02-30", shift: null, time: null }, 1)).toBeNull();
    expect(slotKey(undefined as unknown as LogEntry, 1)).toBeNull();
  });

  it("names the register kind from shifts per day", () => {
    expect(registerKind(plant({ shiftsPerDay: 1 }))).toBe("daily");
    expect(registerKind(plant({ shiftsPerDay: 2 }))).toBe("shift");
    expect(registerKind(null)).toBe("shift");
  });
});

describe("mergeEntries", () => {
  it("daily register: reading the same page again replaces, never doubles", () => {
    const first = [entry("a1", { date: "2026-09-01" }), entry("a2", { date: "2026-09-02" })];
    const again = [entry("b1", { date: "2026-09-01" }), entry("b2", { date: "2026-09-02" }), entry("b3", { date: "2026-09-03" })];
    const { entries, replaced } = mergeEntries(first, again, 1);
    expect(entries.map((e) => e.id)).toEqual(["b1", "b2", "b3"]);
    expect(replaced.map((e) => e.id)).toEqual(["a1", "a2"]);
  });

  it("shift register: only the same date and shift is replaced", () => {
    const old = [entry("a", { shift: "A" }), entry("b", { shift: "B" }), entry("t", { time: "08:00" })];
    const inc = [entry("b2", { shift: "B" }), entry("t2", { time: "08:00" }), entry("c", { shift: "C" })];
    const { entries, replaced } = mergeEntries(old, inc, 3);
    expect(entries.map((e) => e.id)).toEqual(["a", "b2", "t2", "c"]);
    expect(replaced.map((e) => e.id)).toEqual(["b", "t"]);
  });

  it("shift register: rows with no shift and no time are always added", () => {
    const { entries, replaced } = mergeEntries([entry("a")], [entry("b")], 3);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(replaced).toEqual([]);
  });

  it("an undated row never replaces or is replaced, even in a daily register", () => {
    const { entries } = mergeEntries([entry("a", { date: "" })], [entry("b", { date: "" })], 1);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("the same id replaces itself, and two incoming rows for one slot are both kept", () => {
    const { entries } = mergeEntries(
      [entry("a", { date: "2026-09-01", shift: "A" })],
      [entry("a", { date: "2026-09-05", shift: "A" }), entry("x", { date: "2026-09-05", shift: "A" })],
      3,
    );
    expect(entries.map((e) => `${e.id}@${e.date}`)).toEqual(["a@2026-09-05", "x@2026-09-05"]);
  });

  it("daily register: a second page for the same date adds its columns and keeps the first page's", () => {
    // left-hand page: meters. right-hand page: dosing, with one blank cell.
    const left = entry("L", {
      values: { inletTotaliser: 1200, outletTotaliser: 1100, energyKwh: 500 }, operator: "Sunil", remarks: "meter cleaned", pageId: "pg-left",
      cellMeta: { energyKwh: { raw: "5OO", confidence: "low" } }, edited: ["outletTotaliser"],
    });
    const right = entry("R", {
      values: { limeKg: 0.5, alumKg: null, energyKwh: 505 }, operator: null, pageId: "pg-right",
      cellMeta: { limeKg: { raw: "500g", confidence: "low" } }, edited: [],
    });
    const { entries, replaced } = mergeEntries([left], [right], 1);
    expect(replaced.map((e) => e.id)).toEqual(["L"]);
    expect(entries).toHaveLength(1);
    const row = entries[0];
    expect(row.id).toBe("R");
    expect(row.pageId).toBe("pg-right");
    // columns only the first page had are kept; a column on both takes the new value
    expect(row.values).toEqual({ inletTotaliser: 1200, outletTotaliser: 1100, energyKwh: 505, limeKg: 0.5, alumKg: null });
    expect(row.cellMeta).toEqual({ limeKg: { raw: "500g", confidence: "low" } });
    expect(row.edited).toEqual(["outletTotaliser"]);
    expect(row.operator).toBe("Sunil");
    expect(row.remarks).toBe("meter cleaned");
    // inputs untouched
    expect(left.values).toEqual({ inletTotaliser: 1200, outletTotaliser: 1100, energyKwh: 500 });
    expect(right.values).toEqual({ limeKg: 0.5, alumKg: null, energyKwh: 505 });
  });

  it("daily register: a cell left blank on the new page clears the old value, an absent column does not", () => {
    const old = entry("a", { values: { limeKg: 5, sludgeKg: 3 } });
    const inc = entry("b", { values: { limeKg: null } });
    expect(mergeEntries([old], [inc], 1).entries[0].values).toEqual({ limeKg: null, sludgeKg: 3 });
  });

  it("daily register: damaged old values are not carried, and an edit by id is a plain replacement", () => {
    const old = entry("a", { values: { limeKg: NaN, sludgeKg: "3" as unknown as number, runHours: 6 } });
    expect(mergeEntries([old], [entry("b", { values: {} })], 1).entries[0].values).toEqual({ runHours: 6 });
    // the same id coming in again (an edit in the Log) must not resurrect a value the person cleared
    const edited = mergeEntries([old], [entry("a", { values: { limeKg: 1 } })], 1).entries;
    expect(edited).toHaveLength(1);
    expect(edited[0].values).toEqual({ limeKg: 1 });
  });

  it("shift register: a replacement is whole, nothing is carried over", () => {
    const old = entry("a", { shift: "A", values: { phOutlet: 7, codOutlet: 80 } });
    const inc = entry("b", { shift: "A", values: { phOutlet: 7.4 } });
    expect(mergeEntries([old], [inc], 3).entries[0].values).toEqual({ phOutlet: 7.4 });
  });

  it("does not mutate its inputs and copes with empty lists", () => {
    const old = [entry("a", { shift: "A" })];
    const inc = [entry("b", { shift: "A" })];
    mergeEntries(old, inc, 3);
    expect(old.map((e) => e.id)).toEqual(["a"]);
    expect(inc.map((e) => e.id)).toEqual(["b"]);
    expect(mergeEntries([], [], 1)).toEqual({ entries: [], replaced: [] });
  });
});

describe("ops", () => {
  const start: State = { plant: plant({ shiftsPerDay: 1 }), entries: [], pages: [] };

  it("addEntries stores the page without its photo and uses the plant's register kind", () => {
    const s1 = ops.addEntries(page("pg1"), [entry("a", { pageId: "pg1" })])(start);
    expect(s1.pages).toHaveLength(1);
    expect(s1.pages[0].imageDataUrl).toBe("");
    const s2 = ops.addEntries(page("pg2"), [entry("b", { pageId: "pg2" })])(s1);
    // same date in a daily register: "a" is replaced, and page pg1 has no rows left
    expect(s2.entries.map((e) => e.id)).toEqual(["b"]);
    expect(s2.pages.map((p) => p.id)).toEqual(["pg2"]);
  });

  it("a single manual entry (no page) replaces the slot it names", () => {
    const s1 = ops.addEntries(null, [entry("a")])(start);
    const s2 = ops.addEntries(null, [entry("b")])(s1);
    expect(s2.entries.map((e) => e.id)).toEqual(["b"]);
    expect(s2.pages).toEqual([]);
  });

  it("deleteEntry drops a page record once its last row is gone", () => {
    const s0: State = { ...start, plant: plant({ shiftsPerDay: 3 }) };
    const s1 = ops.addEntries(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" }), entry("b", { pageId: "pg1", shift: "B" })])(s0);
    const s2 = ops.deleteEntry("a")(s1);
    expect(s2.pages).toHaveLength(1);
    const s3 = ops.deleteEntry("b")(s2);
    expect(s3.pages).toEqual([]);
    expect(ops.deleteEntry("nope")(s3)).toEqual(s3);
  });

  it("updateEntry changes only the entry with that id", () => {
    const s1: State = { ...start, entries: [entry("a"), entry("b", { date: "2026-09-02" })] };
    const s2 = ops.updateEntry(entry("b", { date: "2026-09-02", remarks: "checked" }))(s1);
    expect(s2.entries.map((e) => e.remarks)).toEqual([null, "checked"]);
    expect(ops.updateEntry(entry("zzz"))(s1).entries).toEqual(s1.entries);
  });
});

// ------------------------------------------------------------- stored data

describe("sanitizeState", () => {
  it("nothing stored is an empty record, not a problem", () => {
    expect(sanitizeState(undefined)).toMatchObject({ state: EMPTY, problem: "none", rev: 0 });
    expect(sanitizeState(null).problem).toBe("none");
    expect(sanitizeState({}).state).toEqual(EMPTY);
  });

  it("a value that is not a record is reported as unreadable", () => {
    for (const junk of ["{\"plant\":1}", 42, true, [1, 2, 3]]) {
      const res = sanitizeState(junk);
      expect(res.problem, JSON.stringify(junk)).toBe("unreadable");
      expect(res.state).toEqual(EMPTY);
    }
  });

  it("leaves a good record exactly as it was", () => {
    const seed = buildSeed("2026-09-27");
    const res = sanitizeState({ plant: seed.plant, entries: seed.entries, pages: [], rev: 7 });
    expect(res.problem).toBe("none");
    expect(res.dropped).toBe(0);
    expect(res.rev).toBe(7);
    expect(res.state.plant).toEqual(seed.plant);
    expect(res.state.entries).toEqual(seed.entries);
  });

  it("keeps daily-register entries (no shift, no time) and the new parameters", () => {
    const e = entry("d1", { values: { inletTotaliser: 120450, outletTotaliser: 120450, runHours: 8, limeKg: 0.5, alumKg: 1, chlorineKg: 0.25, sludgeKg: 12, energyKwh: 5003 } });
    const res = sanitizeState({ plant: plant({ shiftsPerDay: 1 }), entries: [e], pages: [] });
    expect(res.problem).toBe("none");
    expect(res.state.entries[0]).toEqual(e);
    expect(res.state.plant?.shiftsPerDay).toBe(1);
  });

  it("drops what cannot be an entry, repairs what can, and says how many were dropped", () => {
    const res = sanitizeState({
      plant: plant(),
      entries: [
        entry("ok"),
        null,
        "row",
        { id: "empty", values: {} },
        { id: "nums", date: "2026-09-03", shift: "Z", time: "8:05", values: { phOutlet: "7.4", codOutlet: NaN, bodOutlet: Infinity, tssOutlet: null, madeUp: 5 }, edited: ["phOutlet", "madeUp"], cellMeta: { phOutlet: { raw: "7.4" }, madeUp: { raw: "x" } } },
        { date: "2026-09-04", remarks: "  pump off  ", values: "none" },
      ],
      pages: [null, { id: "" }, { id: "pg", notes: ["a", 5] }],
    });
    expect(res.problem).toBe("partial");
    expect(res.dropped).toBe(5); // null, "row", the empty row, and two bad pages
    expect(res.state.entries.map((e) => e.id)).toEqual(["ok", "nums", "recovered-5"]);
    const nums = res.state.entries[1];
    expect(nums.shift).toBeNull();
    expect(nums.time).toBe("08:05");
    expect(nums.values).toEqual({ phOutlet: 7.4, tssOutlet: null });
    expect(nums.edited).toEqual(["phOutlet"]);
    expect(nums.cellMeta).toEqual({ phOutlet: { raw: "7.4", confidence: "low" } });
    expect(res.state.entries[2]).toMatchObject({ remarks: "pump off", values: {}, plantId: "p1", capturedAt: "" });
    expect(res.state.pages).toEqual([{ id: "pg", plantId: "", uploadedAt: "", fileName: "", imageDataUrl: "", model: "", notes: ["a"], reviewedAt: null }]);
  });

  it("renames duplicate ids instead of losing a reading", () => {
    const res = sanitizeState({ plant: plant(), entries: [entry("a"), entry("a", { date: "2026-09-02" }), entry("a", { date: "2026-09-03" })] });
    expect(res.state.entries.map((e) => e.id)).toEqual(["a", "a~2", "a~3"]);
    expect(res.problem).toBe("partial");
    expect(res.dropped).toBe(0);
  });

  it("repairs a damaged plant without inventing a capacity", () => {
    const res = sanitizeState({ plant: { name: "  ", kind: "XYZ", capacityKld: "abc", shiftsPerDay: 9, limits: { phOutlet: { min: "6.5", max: 9 }, bodOutlet: { max: "x" }, nope: { max: 1 } } }, entries: "lots" });
    expect(res.state.plant).toEqual({
      id: "plant-recovered", name: "My plant", kind: "STP", location: "", capacityKld: 0, technology: "",
      operatorCompany: "", consentNo: "", shiftsPerDay: 3, limits: { phOutlet: { min: 6.5, max: 9 } },
    });
    expect(res.problem).toBe("partial");
    expect(sanitizeState({ plant: "Aravali", entries: [] }).problem).toBe("partial");
  });

  it("pulls photos out of an earlier layout that kept them inside the record", () => {
    const res = sanitizeState({ plant: plant(), entries: [entry("a", { pageId: "pg" })], pages: [page("pg")] });
    expect(res.state.pages[0].imageDataUrl).toBe("");
    expect(res.inlinePhotos).toEqual([{ id: "pg", dataUrl: "data:image/jpeg;base64,AAAA" }]);
    expect(res.problem).toBe("none");
  });

  it("is stable: cleaning a cleaned record changes nothing", () => {
    const once = sanitizeState({ plant: { name: "X" }, entries: [{ date: "2026-09-01", values: { mlss: "3100" } }], pages: [], rev: "4" });
    const twice = sanitizeState({ ...once.state, rev: once.rev });
    expect(twice.state).toEqual(once.state);
    expect(twice.rev).toBe(4);
    expect(twice.problem).toBe("none");
  });
});

// ------------------------------------------------------------ demo plants

describe("demo plants", () => {
  it("the 3-shift sample is available and recognised", () => {
    const demo = demoState("shift");
    expect(demo?.plant?.shiftsPerDay).toBe(3);
    expect(demo?.entries.length).toBeGreaterThan(50);
    expect(demoKindOf(demo!.plant)).toBe("shift");
    expect(demoKindOf(plant())).toBeNull();
    expect(demoKindOf(null)).toBeNull();
  });

  it("the daily-register sample is one row a day with no shift or time", () => {
    const demo = demoState("daily")!;
    expect(demo, "buildDailySeed gave no usable record").not.toBeNull();
    expect(demo.plant?.shiftsPerDay).toBe(1);
    expect(demo.plant?.id).not.toBe(demoState("shift")!.plant!.id);
    expect(demoKindOf(demo.plant)).toBe("daily");
    const dates = demo.entries.map((e) => e.date);
    expect(new Set(dates).size, "one row per date").toBe(dates.length);
    expect(demo.entries.every((e) => e.shift === null && e.time === null), "no shift letters or times").toBe(true);
    // loading it twice into a daily plant must replace, not double
    const again = mergeEntries(demo.entries, demo.entries.map((e) => ({ ...e, id: `${e.id}-again` })), 1);
    expect(again.entries).toHaveLength(demo.entries.length);
  });
});

// ------------------------------------------------------------------- vault

describe("vault", () => {
  it("starts empty and ready when nothing is stored", async () => {
    const b = browser();
    const t = b.tab();
    expect(t.vault.getSnapshot().ready).toBe(false);
    await settle(t);
    expect(t.vault.getSnapshot()).toMatchObject({ ready: true, state: EMPTY, storageError: null, recovery: null });
    expect(b.stored(), "loading must not write").toBeUndefined();
    expect(t.ctl.writes).toBe(0);
  });

  it("shows a change at once, stores it, and a fresh tab reads it back", async () => {
    const b = browser();
    const t = b.tab();
    await settle(t);
    t.vault.mutate(ops.savePlant(plant()));
    expect(t.state().plant?.name, "visible before the write finishes").toBe("Test STP");
    t.vault.mutate(ops.addEntries(null, [entry("a", { shift: "A" })]));
    await settle(t);
    // both changes were waiting when the write ran, so they went in as one
    expect(b.stored()).toMatchObject({ rev: 1, plant: { id: "p1" } });
    expect(ids(b.stored()!)).toEqual(["a"]);
    const t2 = b.tab();
    await settle(t2);
    expect(t2.state().plant).toEqual(plant());
    expect(ids(t2.state())).toEqual(["a"]);
  });

  it("a change made before the first load finishes is applied on top of what was stored", async () => {
    const b = browser();
    b.data.set(STORAGE_KEYS.state, { plant: plant(), entries: [entry("old", { shift: "A" })], pages: [], rev: 4 });
    const t = b.tab();
    t.vault.mutate(ops.addEntries(null, [entry("new", { shift: "B" })]));
    await settle(t);
    expect(ids(t.state())).toEqual(["new", "old"]);
    expect(ids(b.stored()!)).toEqual(["new", "old"]);
    expect(b.stored()!.rev).toBe(5);
  });

  it("keeps a page photo under its own key and hands it back", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    t.vault.addPage(page("pg1", "data:image/jpeg;base64,PHOTO"), [entry("a", { pageId: "pg1", shift: "A" })]);
    await settle(t);
    expect(b.data.get(STORAGE_KEYS.imagePrefix + "pg1")).toBe("data:image/jpeg;base64,PHOTO");
    expect(b.stored()!.pages[0].imageDataUrl).toBe("");
    expect(JSON.stringify(b.stored())).not.toContain("PHOTO");
    expect(await t.vault.getPageImage("pg1")).toBe("data:image/jpeg;base64,PHOTO");
    expect(await t.vault.getPageImage("missing")).toBeNull();
  });

  it("deleting all data removes the record's contents, every photo and the unsaved page", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    t.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" })]);
    t.vault.addPage(page("pg2"), [entry("b", { pageId: "pg2", shift: "B" })]);
    void t.vault.draft.save("rv1", { rows: [] }, "data:image/jpeg;base64,DRAFT");
    b.data.set(STORAGE_KEYS.imagePrefix + "orphan", "data:image/jpeg;base64,OLD");
    b.data.set("another-app", "untouched");
    await settle(t);
    expect([...b.data.keys()].filter((k) => k.startsWith(STORAGE_KEYS.imagePrefix))).toHaveLength(3);

    t.vault.mutate(ops.replaceAll(EMPTY), "all");
    await settle(t);
    expect([...b.data.keys()].sort()).toEqual(["another-app", STORAGE_KEYS.state].sort());
    expect(b.stored()).toMatchObject({ plant: null, entries: [], pages: [] });
    expect(await t.vault.draft.load()).toBeNull();
  });

  it("loading a sample plant removes the old photos but keeps a page being checked", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    t.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" })]);
    void t.vault.draft.save("rv1", { rows: [1] }, "data:image/jpeg;base64,DRAFT");
    await settle(t);
    t.vault.mutate(ops.replaceAll(demoState("shift")!), "photos");
    await settle(t);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg1")).toBe(false);
    expect(await t.vault.draft.load()).toEqual({ id: "rv1", meta: { rows: [1] }, image: "data:image/jpeg;base64,DRAFT" });
    expect(t.state().plant?.id).toBe(demoState("shift")!.plant!.id);
  });

  it("a photo can be read back the moment its page is saved, and just before its delete", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    t.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" })]);
    // no settle: the read must wait its turn behind the write
    expect(await t.vault.getPageImage("pg1")).toBe("data:image/jpeg;base64,AAAA");
    // asked for before the delete, answered with the photo even though the delete then removes it
    const before = t.vault.getPageImage("pg1");
    t.vault.mutate(ops.deleteEntry("a"));
    expect(await before).toBe("data:image/jpeg;base64,AAAA");
    await settle(t);
    expect(await t.vault.getPageImage("pg1")).toBeNull();
    expect(await t.vault.getPageImage("never-existed")).toBeNull();
    t.ctl.failReads = true;
    expect(await t.vault.getPageImage("pg1")).toBeNull();
  });

  it("removes the photo when the last row of its page is deleted or replaced", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant({ shiftsPerDay: 1 })));
    t.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1" })]);
    await settle(t);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg1")).toBe(true);
    // the same day's page is photographed again
    t.vault.addPage(page("pg2"), [entry("b", { pageId: "pg2" })]);
    await settle(t);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg1")).toBe(false);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg2")).toBe(true);
    t.vault.mutate(ops.deleteEntry("b"));
    await settle(t);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg2")).toBe(false);
    expect(t.state().pages).toEqual([]);
  });

  it("a refused write is reported, nothing is lost from the screen, and a retry stores everything", async () => {
    const b = browser();
    const t = b.tab();
    await settle(t);
    t.vault.mutate(ops.savePlant(plant()));
    await settle(t);

    t.ctl.failWrites = true;
    t.vault.mutate(ops.addEntries(null, [entry("a", { shift: "A" })]));
    t.vault.mutate(ops.addEntries(null, [entry("b", { shift: "B" })]));
    await settle(t);
    expect(t.vault.getSnapshot().storageError).toMatch(/not saving/);
    expect(ids(t.state()), "still on screen").toEqual(["a", "b"]);
    expect(ids(b.stored()!), "not in storage yet").toEqual([]);

    t.ctl.failWrites = false;
    void t.vault.retry();
    await settle(t);
    expect(t.vault.getSnapshot().storageError).toBeNull();
    expect(ids(b.stored()!)).toEqual(["a", "b"]);
    expect(ids(t.state())).toEqual(["a", "b"]);
  });

  it("storage that cannot even be read gives a ready, empty app with the error showing", async () => {
    const b = browser();
    const t = b.tab();
    t.ctl.failReads = true;
    t.ctl.failWrites = true;
    await settle(t);
    expect(t.vault.getSnapshot()).toMatchObject({ ready: true, state: EMPTY });
    expect(t.vault.getSnapshot().storageError).toMatch(/not saving/);
    t.vault.mutate(ops.savePlant(plant()));
    await settle(t);
    expect(t.state().plant?.id, "usable in memory").toBe("p1");
    expect(t.vault.getSnapshot().storageError).toMatch(/not saving/);
  });

  it("a photo that cannot be stored is reported but the readings are still saved", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    await settle(t);
    t.ctl.refuse = (k) => k.startsWith(STORAGE_KEYS.imagePrefix);
    t.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" })]);
    await settle(t);
    expect(ids(b.stored()!)).toEqual(["a"]);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg1")).toBe(false);
    expect(t.vault.getSnapshot().storageError).toMatch(/photo/);
    expect(await t.vault.getPageImage("pg1")).toBeNull();
    t.vault.dismissNotice();
    expect(t.vault.getSnapshot().storageError).toBeNull();
  });

  it("two tabs: a save in one shows up in the other", async () => {
    const b = browser();
    const t1 = b.tab();
    const t2 = b.tab();
    await settle(t1, t2);
    t1.vault.mutate(ops.savePlant(plant()));
    t1.vault.mutate(ops.addEntries(null, [entry("a", { shift: "A" })]));
    await settle(t1, t2);
    expect(t2.state().plant?.name).toBe("Test STP");
    expect(ids(t2.state())).toEqual(["a"]);
    expect(t2.ctl.writes, "the reading tab only reads").toBe(0);

    t2.vault.mutate(ops.deleteEntry("a"));
    await settle(t1, t2);
    expect(ids(t1.state())).toEqual([]);
  });

  it("two tabs saving at the same moment keep both changes", async () => {
    const b = browser();
    b.data.set(STORAGE_KEYS.state, { plant: plant(), entries: [entry("e1", { shift: "A" })], pages: [], rev: 1 });
    const t1 = b.tab();
    const t2 = b.tab();
    await settle(t1, t2);
    // neither tab has heard of the other's change when it writes
    t1.vault.mutate(ops.addEntries(null, [entry("e2", { shift: "B" })]));
    t2.vault.mutate(ops.addEntries(null, [entry("e3", { shift: "C" })]));
    await settle(t1, t2);
    expect(ids(b.stored()!)).toEqual(["e1", "e2", "e3"]);
    expect(ids(t1.state())).toEqual(["e1", "e2", "e3"]);
    expect(ids(t2.state())).toEqual(["e1", "e2", "e3"]);
    expect(b.stored()!.rev).toBe(3);
  });

  it("two tabs without a channel: the stale tab catches up when it looks again, and its own save builds on the other's", async () => {
    const data = new Map<string, unknown>();
    const kv: KV = {
      get: async (k) => structuredClone(data.get(k)),
      set: async (k, v) => void data.set(k, structuredClone(v)),
      update: async (k, fn) => void data.set(k, structuredClone(fn(structuredClone(data.get(k))))),
      keys: async () => [...data.keys()],
      delMany: async (ks) => ks.forEach((k) => data.delete(k)),
    };
    const a = createVault(kv);
    const c = createVault(kv);
    a.start();
    c.start();
    await a.idle();
    await c.idle();
    a.mutate(ops.savePlant(plant()));
    a.mutate(ops.addEntries(null, [entry("a", { shift: "A" })]));
    await a.idle();
    expect(c.getSnapshot().state.plant, "no channel, so not told").toBeNull();
    c.mutate(ops.addEntries(null, [entry("c", { shift: "C" })]));
    await c.idle();
    expect(ids(c.getSnapshot().state)).toEqual(["a", "c"]);
    expect(c.getSnapshot().state.plant?.id).toBe("p1");
    await a.refresh();
    expect(ids(a.getSnapshot().state)).toEqual(["a", "c"]);
  });

  it("an unreadable stored value does not crash, is not overwritten on load, and is offered back", async () => {
    const b = browser();
    b.data.set(STORAGE_KEYS.state, "<<garbage>>");
    const t = b.tab();
    await settle(t);
    const snap = t.vault.getSnapshot();
    expect(snap.ready).toBe(true);
    expect(snap.state).toEqual(EMPTY);
    expect(snap.recovery).toEqual({ kind: "unreadable", dropped: 0, raw: "<<garbage>>" });
    expect(b.data.get(STORAGE_KEYS.state), "left as found until the user acts").toBe("<<garbage>>");
    // "start fresh"
    t.vault.mutate(ops.replaceAll(EMPTY), "all");
    t.vault.dismissRecovery();
    await settle(t);
    expect(t.vault.getSnapshot().recovery).toBeNull();
    expect(b.stored()).toMatchObject({ plant: null, entries: [], pages: [], rev: 1 });
  });

  it("a partly damaged record loads what it can and reports the rest", async () => {
    const b = browser();
    b.data.set(STORAGE_KEYS.state, { plant: plant(), entries: [entry("ok", { shift: "A" }), 17, { id: "blank" }], pages: [], rev: 2 });
    const t = b.tab();
    await settle(t);
    expect(ids(t.state())).toEqual(["ok"]);
    expect(t.vault.getSnapshot().recovery).toMatchObject({ kind: "partial", dropped: 2 });
    expect(t.ctl.writes, "loading must not rewrite the damaged record").toBe(0);
  });

  it("moves photos out of an earlier layout on first load", async () => {
    const b = browser();
    b.data.set(STORAGE_KEYS.state, { plant: plant(), entries: [entry("a", { pageId: "pg", shift: "A" })], pages: [page("pg", "data:image/jpeg;base64,INLINE")] });
    const t = b.tab();
    await settle(t);
    expect(b.data.get(STORAGE_KEYS.imagePrefix + "pg")).toBe("data:image/jpeg;base64,INLINE");
    expect(JSON.stringify(b.stored())).not.toContain("INLINE");
    expect(await t.vault.getPageImage("pg")).toBe("data:image/jpeg;base64,INLINE");
    expect(t.vault.getSnapshot().recovery).toBeNull();
  });

  it("an op that throws leaves the record as it was", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    t.vault.mutate(() => { throw new Error("bad op"); });
    await settle(t);
    expect(t.state().plant?.id).toBe("p1");
    expect(b.stored()!.plant?.id).toBe("p1");
    expect(t.vault.getSnapshot().storageError).toBeNull();
  });

  it("tells subscribers only when something changed, and keeps the state object when a save confirms it", async () => {
    const b = browser();
    const t = b.tab();
    await settle(t);
    let calls = 0;
    const off = t.vault.subscribe(() => calls++);
    t.vault.mutate(ops.savePlant(plant()));
    const shown = t.state();
    await settle(t);
    expect(calls).toBe(1);
    expect(t.state(), "same object, so screens do not re-run the checks").toBe(shown);
    off();
    t.vault.mutate(ops.savePlant(plant({ name: "Renamed" })));
    await settle(t);
    expect(calls).toBe(1);
  });

  it("a save says whether it reached storage, and a refused one leaves the review's stored copy in place until a retry stores it", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    expect(await t.vault.draft.save("rv1", { rows: [1] }, "data:image/jpeg;base64,DRAFT")).toBe(true);
    await settle(t);

    t.ctl.failWrites = true;
    const stored = await t.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" })], { draftId: "rv1" });
    expect(stored, "the write was refused").toBe(false);
    expect(ids(t.state()), "still on screen").toEqual(["a"]);
    expect(ids(b.stored()!), "not on disk").toEqual([]);
    expect((await t.vault.draft.load())?.id, "the reviewed page is still the fallback").toBe("rv1");
    expect(t.vault.getSnapshot().retryable).toBe(true);

    t.ctl.failWrites = false;
    await t.vault.retry();
    await settle(t);
    expect(ids(b.stored()!)).toEqual(["a"]);
    expect(await t.vault.draft.load(), "removed once the entries are on disk").toBeNull();
    expect(b.data.has(STORAGE_KEYS.draftImage)).toBe(false);
    expect(t.vault.getSnapshot()).toMatchObject({ storageError: null, retryable: false });

    // the ordinary case: stored at once, the copy goes with it
    await t.vault.draft.save("rv2", { rows: [2] }, "data:image/jpeg;base64,D2");
    expect(await t.vault.addPage(page("pg2"), [entry("b", { pageId: "pg2", shift: "B" })], { draftId: "rv2" })).toBe(true);
    expect(await t.vault.draft.load()).toBeNull();
    // a save that names a review must not remove some other review's copy
    await t.vault.draft.save("rv3", { rows: [3] }, "data:image/jpeg;base64,D3");
    expect(await t.vault.addPage(page("pg4"), [entry("c", { pageId: "pg4", shift: "C" })], { draftId: "rv2" })).toBe(true);
    expect((await t.vault.draft.load())?.id).toBe("rv3");
  });

  it("try again also stores the page photo that was refused with the record", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    await settle(t);
    t.ctl.failWrites = true;
    void t.vault.addPage(page("pg1", "data:image/jpeg;base64,PHOTO"), [entry("a", { pageId: "pg1", shift: "A" })]);
    await settle(t);
    expect(t.vault.getSnapshot().storageError).toMatch(/not saving/);
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg1")).toBe(false);

    t.ctl.failWrites = false;
    await t.vault.retry();
    await settle(t);
    expect(ids(b.stored()!)).toEqual(["a"]);
    expect(b.data.get(STORAGE_KEYS.imagePrefix + "pg1"), "the photo went in with the retry").toBe("data:image/jpeg;base64,PHOTO");
    expect(await t.vault.getPageImage("pg1")).toBe("data:image/jpeg;base64,PHOTO");
    expect(t.vault.getSnapshot()).toMatchObject({ storageError: null, retryable: false });
  });

  it("a photo refused on its own can be retried, and is forgotten once its page is gone", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    await settle(t);
    t.ctl.refuse = (k) => k.startsWith(STORAGE_KEYS.imagePrefix);
    expect(await t.vault.addPage(page("pg1", "data:image/jpeg;base64,P1"), [entry("a", { pageId: "pg1", shift: "A" })])).toBe(true);
    expect(await t.vault.addPage(page("pg2", "data:image/jpeg;base64,P2"), [entry("b", { pageId: "pg2", shift: "B" })])).toBe(true);
    await settle(t);
    expect(t.vault.getSnapshot()).toMatchObject({ retryable: true });
    expect(t.vault.getSnapshot().storageError).toMatch(/photo/);
    // a retry while storage still refuses keeps the notice
    await t.vault.retry();
    expect(t.vault.getSnapshot().storageError).toMatch(/photo/);

    t.vault.mutate(ops.deleteEntry("b")); // page pg2 leaves the record
    t.ctl.refuse = null;
    await t.vault.retry();
    await settle(t);
    expect(b.data.get(STORAGE_KEYS.imagePrefix + "pg1")).toBe("data:image/jpeg;base64,P1");
    expect(b.data.has(STORAGE_KEYS.imagePrefix + "pg2"), "no photo for a page that was deleted").toBe(false);
    expect(t.vault.getSnapshot()).toMatchObject({ storageError: null, retryable: false });
  });

  it("holds only the last few refused photos, and then keeps saying that one is missing", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant()));
    t.ctl.refuse = (k) => k.startsWith(STORAGE_KEYS.imagePrefix);
    const shifts = ["A", "B", "C"] as const;
    for (let i = 0; i < 5; i++) {
      void t.vault.addPage(page(`pg${i}`, `data:image/jpeg;base64,P${i}`), [entry(`e${i}`, { pageId: `pg${i}`, date: `2026-09-0${i + 1}`, shift: shifts[i % 3] })]);
    }
    await settle(t);
    t.ctl.refuse = null;
    await t.vault.retry();
    await settle(t);
    const kept = [...b.data.keys()].filter((k) => k.startsWith(STORAGE_KEYS.imagePrefix)).sort();
    expect(kept).toEqual(["pg2", "pg3", "pg4"].map((id) => STORAGE_KEYS.imagePrefix + id));
    expect(t.vault.getSnapshot().storageError, "two photos could not be kept for the retry").toMatch(/photo/);
    expect(ids(b.stored()!)).toHaveLength(5);
  });

  it("the unsaved-page draft round-trips, clears, and reports a refused write", async () => {
    const b = browser();
    const t = b.tab();
    expect(await t.vault.draft.load()).toBeNull();
    expect(await t.vault.draft.save("rv1", { rows: [{ date: "2026-09-01" }] }, "data:image/jpeg;base64,D")).toBe(true);
    const writes = t.ctl.writes;
    expect(await t.vault.draft.save("rv1", { rows: [{ date: "2026-09-02" }] }, "data:image/jpeg;base64,D")).toBe(true);
    expect(t.ctl.writes - writes, "an edit rewrites the rows, not the photo").toBe(1);
    expect(await t.vault.draft.load()).toEqual({ id: "rv1", meta: { rows: [{ date: "2026-09-02" }] }, image: "data:image/jpeg;base64,D" });
    await t.vault.draft.clear("rv1");
    expect(await t.vault.draft.load()).toBeNull();
    expect(b.data.size).toBe(0);
    t.ctl.failWrites = true;
    expect(await t.vault.draft.save("rv1", { rows: [] }, "data:image/jpeg;base64,D")).toBe(false);
    t.ctl.failReads = true;
    expect(await t.vault.draft.load()).toBeNull();
  });

  it("a draft whose photo was refused is reported, and the next edit stores the photo", async () => {
    const b = browser();
    const t = b.tab();
    t.ctl.refuse = (k) => k === STORAGE_KEYS.draftImage;
    expect(await t.vault.draft.save("rv1", { rows: [1] }, "data:image/jpeg;base64,BIG")).toBe(false);
    expect(await t.vault.draft.load(), "no rows without their photo").toBeNull();
    t.ctl.refuse = null;
    expect(await t.vault.draft.save("rv1", { rows: [1, 2] }, "data:image/jpeg;base64,BIG")).toBe(true);
    expect(await t.vault.draft.load()).toEqual({ id: "rv1", meta: { rows: [1, 2] }, image: "data:image/jpeg;base64,BIG" });
  });

  it("two tabs: the rows of one review never come back beside another review's photo", async () => {
    const b = browser();
    const t1 = b.tab();
    const t2 = b.tab();
    await settle(t1, t2);
    const PA = "data:image/jpeg;base64,PAGE-A";
    const PB = "data:image/jpeg;base64,PAGE-B";
    await t1.vault.draft.save("A", { page: "A", n: 1 }, PA);
    await t2.vault.draft.save("B", { page: "B", n: 1 }, PB);
    expect(await t1.vault.draft.load()).toEqual({ id: "B", meta: { page: "B", n: 1 }, image: PB });
    // tab 1 edits a cell. Writing only its rows would leave them beside B's photo.
    expect(await t1.vault.draft.save("A", { page: "A", n: 2 }, PA)).toBe(true);
    expect(await t2.vault.draft.load()).toEqual({ id: "A", meta: { page: "A", n: 2 }, image: PA });
    // a pair that does not belong together (a write that stopped half way) is handed back without the photo
    b.data.set(STORAGE_KEYS.draftImage, { id: "B", dataUrl: PB });
    expect(await t1.vault.draft.load()).toEqual({ id: "A", meta: { page: "A", n: 2 }, image: null });
    b.data.set(STORAGE_KEYS.draftImage, PB);
    expect((await t2.vault.draft.load())?.image).toBeNull();
    // and the tab that owns the rows puts its photo back on its next edit
    expect(await t1.vault.draft.save("A", { page: "A", n: 3 }, PA)).toBe(true);
    expect(await t2.vault.draft.load()).toEqual({ id: "A", meta: { page: "A", n: 3 }, image: PA });
  });

  it("two tabs: discarding in one is told to the other, which can store its copy again", async () => {
    const b = browser();
    const t1 = b.tab();
    const t2 = b.tab();
    await settle(t1, t2);
    const PA = "data:image/jpeg;base64,PAGE-A";
    const heard: unknown[] = [];
    const off = t1.vault.draft.onCleared((m) => heard.push(m));
    await t1.vault.draft.save("A", { n: 1 }, PA);
    await t2.vault.draft.clear("some-other-review");
    await settle(t1, t2);
    expect(heard, "not its review: nothing removed").toEqual([]);
    expect((await t2.vault.draft.load())?.id).toBe("A");

    await t2.vault.draft.clear(); // "Discard it everywhere" in the second tab
    await settle(t1, t2);
    expect(heard).toEqual([{ id: "A", reason: "discarded" }]);
    expect(await t1.vault.draft.load()).toBeNull();
    // the next edit in the tab still reviewing stores the rows and the photo again
    expect(await t1.vault.draft.save("A", { n: 2 }, PA)).toBe(true);
    expect(await t2.vault.draft.load()).toEqual({ id: "A", meta: { n: 2 }, image: PA });

    // saving the page to the log is announced as "saved", not as a discard
    t1.vault.mutate(ops.savePlant(plant()));
    const t3 = b.tab();
    const heard3: unknown[] = [];
    t3.vault.draft.onCleared((m) => heard3.push(m));
    await settle(t1, t2, t3);
    await t1.vault.addPage(page("pg1"), [entry("a", { pageId: "pg1", shift: "A" })], { draftId: "A" });
    await settle(t1, t2, t3);
    expect(heard3).toEqual([{ id: "A", reason: "saved" }]);
    off();
  });

  it("a draft stored by an earlier build (no ids) still loads", async () => {
    const b = browser();
    b.data.set(STORAGE_KEYS.draft, { v: 1, tab: "t", review: { rows: [] } });
    b.data.set(STORAGE_KEYS.draftImage, "data:image/jpeg;base64,OLD");
    const t = b.tab();
    expect(await t.vault.draft.load()).toEqual({ id: "", meta: { v: 1, tab: "t", review: { rows: [] } }, image: "data:image/jpeg;base64,OLD" });
    await t.vault.draft.clear("anything");
    expect(await t.vault.draft.load()).toBeNull();
  });

  it("a full copy holds the record and its photos, and restoring it replaces everything", async () => {
    const b = browser();
    const t = b.tab();
    t.vault.mutate(ops.savePlant(plant({ name: "Copied STP", limits: { bodOutlet: { max: 10 } } })));
    void t.vault.addPage(page("pg1", "data:image/jpeg;base64,P1"), [entry("a", { pageId: "pg1", shift: "A" }), entry("b", { pageId: "pg1", shift: "B" })]);
    t.vault.mutate(ops.addEntries(null, [entry("m", { date: "2026-09-02", shift: "A" })]));
    await settle(t);
    const copy = await t.vault.exportCopy();
    expect(copy).toMatchObject({ app: "JalLog", format: 1, plant: { name: "Copied STP" }, photos: { pg1: "data:image/jpeg;base64,P1" } });
    expect(ids(copy)).toEqual(["a", "b", "m"]);

    // another browser, with something else in it
    const b2 = browser();
    const t2 = b2.tab();
    t2.vault.mutate(ops.savePlant(plant({ id: "other", name: "Other plant" })));
    void t2.vault.addPage(page("old", "data:image/jpeg;base64,OLD"), [entry("z", { pageId: "old", shift: "C" })]);
    await settle(t2);
    const read = readBackup(JSON.parse(JSON.stringify(copy)));
    expect(read, "the file made by exportCopy is readable").not.toBeNull();
    expect(read!.repaired).toBe(false);
    expect(await t2.vault.restore(read!.state, read!.photos)).toBe(true);
    await settle(t2);
    expect(t2.state().plant).toEqual(plant({ name: "Copied STP", limits: { bodOutlet: { max: 10 } } }));
    expect(ids(t2.state())).toEqual(["a", "b", "m"]);
    expect(await t2.vault.getPageImage("pg1")).toBe("data:image/jpeg;base64,P1");
    expect(b2.data.has(STORAGE_KEYS.imagePrefix + "old"), "the replaced plant's photo is removed").toBe(false);
    expect(t2.state()).toEqual(t.state());
  });
});

describe("full copies", () => {
  const state: State = {
    plant: plant({ shiftsPerDay: 1 }),
    entries: [entry("a", { pageId: "pg1" }), entry("b", { date: "2026-09-02" })],
    pages: [{ ...page("pg1"), imageDataUrl: "" }],
  };

  it("round-trips through JSON unchanged", () => {
    const copy = makeBackup(state, { pg1: "data:image/jpeg;base64,P1" }, "2026-10-04T08:00:00.000Z");
    const read = readBackup(JSON.parse(JSON.stringify(copy)))!;
    expect(read.state).toEqual(state);
    expect(read.photos).toEqual({ pg1: "data:image/jpeg;base64,P1" });
    expect(read).toMatchObject({ dropped: 0, repaired: false, exportedAt: "2026-10-04T08:00:00.000Z" });
  });

  it("refuses what is not a copy, and repairs what it can of a damaged one", () => {
    for (const junk of [null, undefined, 5, "text", [], {}, { entries: [entry("a")] }, { plant: null, entries: [] }, { rows: [1, 2] }]) {
      expect(readBackup(junk), JSON.stringify(junk)).toBeNull();
    }
    const read = readBackup({
      plant: { name: "Hand-edited", capacityKld: "50" },
      entries: [entry("ok"), "junk", { id: "x", date: "2026-09-03", values: { phOutlet: "7.1" } }],
      pages: [{ ...page("pg-unused"), imageDataUrl: "" }, { ...page("pg-inline", "data:image/png;base64,IN") }],
      photos: { "pg-unused": "data:image/jpeg;base64,U", "pg-inline": "javascript:alert(1)", stray: "data:image/jpeg;base64,S" },
      exportedAt: 12,
    })!;
    expect(read.state.plant).toMatchObject({ name: "Hand-edited", capacityKld: 50 });
    expect(read.state.entries.map((e) => e.id)).toEqual(["ok", "x"]);
    expect(read.state.entries[1].values).toEqual({ phOutlet: 7.1 });
    // no entry points at either page, so neither page nor its photo is taken in
    expect(read.state.pages).toEqual([]);
    expect(read.photos).toEqual({});
    expect(read).toMatchObject({ dropped: 3, repaired: true, exportedAt: "" });
  });

  it("takes photos only for pages in the copy, and only image data", () => {
    const read = readBackup({
      plant: plant(),
      entries: [entry("a", { pageId: "pg1", shift: "A" }), entry("b", { pageId: "pg2", shift: "B" })],
      pages: [{ ...page("pg1"), imageDataUrl: "" }, page("pg2", "data:image/jpeg;base64,INLINE")],
      photos: { pg1: "https://example.com/x.jpg", other: "data:image/jpeg;base64,X" },
    })!;
    expect(read.photos).toEqual({ pg2: "data:image/jpeg;base64,INLINE" });
    expect(read.state.pages.every((p) => p.imageDataUrl === "")).toBe(true);
  });
});

describe("review-round fixes", () => {
  it("daily register: a name or remark the reviewer cleared stays cleared; a page without the column keeps it", () => {
    const old = entry("old", { operator: "Sunil", remarks: "pump serviced", values: { limeKg: 0.5 } });
    // "" = the page has the column and the reviewer emptied the cell
    const cleared = mergeEntries([old], [entry("new", { operator: "", remarks: "", values: { limeKg: 0.5 } })], 1).entries[0];
    expect([cleared.operator, cleared.remarks]).toEqual([null, null]);
    // null = the page has no such column (the facing page of the register)
    const facing = mergeEntries([old], [entry("new", { operator: null, remarks: null, values: { alumKg: 1 } })], 1).entries[0];
    expect([facing.operator, facing.remarks]).toEqual(["Sunil", "pump serviced"]);
    expect(facing.values).toEqual({ limeKg: 0.5, alumKg: 1 });
    // one cleared, one absent
    const mixed = mergeEntries([old], [entry("new", { operator: "", remarks: null })], 1).entries[0];
    expect([mixed.operator, mixed.remarks]).toEqual([null, "pump serviced"]);
    // "" never reaches storage, whatever the register kind and whether or not anything was replaced
    for (const per of [1, 3] as const) {
      const fresh = mergeEntries([], [entry("n", { operator: "", remarks: "", shift: "A" })], per).entries[0];
      expect([fresh.operator, fresh.remarks], `shiftsPerDay ${per}`).toEqual([null, null]);
    }
    expect(ops.addEntries(null, [entry("n", { operator: "" })])({ plant: plant(), entries: [], pages: [] }).entries[0].operator).toBeNull();
  });

  it("saveImpact: counts the saved entries a page would remove, not just the rows that replace something", () => {
    // a 3-shift plant switched to one row a day: 20 Sep still holds three entries
    const saved = [
      entry("A", { date: "2026-09-20", shift: "A" }), entry("B", { date: "2026-09-20", shift: "B" }), entry("C", { date: "2026-09-20", shift: "C" }),
      entry("d21", { date: "2026-09-21" }),
    ];
    const pageRows = [entry("n20", { date: "2026-09-20" }), entry("n21", { date: "2026-09-21" }), entry("n22", { date: "2026-09-22" })];
    const daily = saveImpact(saved, pageRows, 1);
    expect(daily).toMatchObject({ replaces: 2, removed: 4, crowded: [{ date: "2026-09-20", count: 3, shifts: ["A", "B", "C"] }] });
    expect(daily.removed, "agrees with what the merge really removes").toBe(mergeEntries(saved, pageRows, 1).replaced.length);
    // the same page in a shift register replaces nothing: its rows have no shift or time
    expect(saveImpact(saved, pageRows, 3)).toEqual({ replaces: 0, removed: 0, crowded: [], corrections: [] });
    // shift register: one for one, never "crowded"
    const shift = saveImpact(saved, [entry("x", { date: "2026-09-20", shift: "B" }), entry("y", { date: "2026-09-20", shift: "B" })], 3);
    expect(shift).toMatchObject({ replaces: 1, removed: 1, crowded: [] });
    expect(saveImpact([], [], 1)).toEqual({ replaces: 0, removed: 0, crowded: [], corrections: [] });
    expect(saveImpact(saved, [entry("bad", { date: "not a date" })], 1).replaces).toBe(0);
  });

  it("saveImpact: names the hand-corrected values a re-read page would overwrite", () => {
    const saved = [
      entry("s1", { date: "2026-09-21", values: { limeKg: 9.9, alumKg: 1, sludgeKg: 2 }, edited: ["limeKg", "sludgeKg"] }),
      entry("s2", { date: "2026-09-22", values: { limeKg: 0.5 }, edited: ["limeKg"] }),
      entry("s3", { date: "2026-09-23", values: { limeKg: 0.7 } }),
    ];
    const rows = [
      // lime read as 0.5 again (differs from the correction), alum unchanged, sludge not a column of this page
      entry("r1", { date: "2026-09-21", values: { limeKg: 0.5, alumKg: 1 } }),
      // same value as the correction: nothing would be lost
      entry("r2", { date: "2026-09-22", values: { limeKg: 0.5 } }),
      // never corrected
      entry("r3", { date: "2026-09-23", values: { limeKg: 0.1 } }),
    ];
    expect(saveImpact(saved, rows, 1).corrections).toEqual([{ row: 0, param: "limeKg", saved: 9.9, incoming: 0.5 }]);
    // a corrected value that the page would blank is also reported
    expect(saveImpact(saved, [entry("r", { date: "2026-09-22", values: { limeKg: null } })], 1).corrections)
      .toEqual([{ row: 0, param: "limeKg", saved: 0.5, incoming: null }]);
    // shift register
    const shiftSaved = [entry("s", { shift: "A", values: { codOutlet: 61 }, edited: ["codOutlet"] })];
    expect(saveImpact(shiftSaved, [entry("r", { shift: "A", values: { codOutlet: 16 } })], 3).corrections).toHaveLength(1);
    // damaged "edited" lists do not throw
    const odd = [entry("s", { edited: "limeKg" as unknown as LogEntry["edited"] })];
    expect(saveImpact(odd, [entry("r")], 1).corrections).toEqual([]);
  });

  it("entries with no plant are reported as damaged, so the recovery banner offers them back", () => {
    const res = sanitizeState({ entries: [entry("a"), entry("b", { date: "2026-09-02" })] });
    expect(res.state.plant).toBeNull();
    expect(res.state.entries).toHaveLength(2);
    expect(res.problem).toBe("partial");
    // an empty record with no plant is still just "nothing stored yet"
    expect(sanitizeState({ plant: null, entries: [], pages: [] }).problem).toBe("none");
  });

  it("a sample plant keeps its label when its shifts per day are changed", () => {
    const shift = demoState("shift")!.plant!;
    const daily = demoState("daily")!.plant!;
    for (const per of [1, 2, 3] as const) {
      const changedShift: Plant = { ...shift, shiftsPerDay: per };
      const changedDaily: Plant = { ...daily, shiftsPerDay: per };
      expect(demoKindOf(changedShift), `3-shift sample set to ${per}`).toBe("shift");
      expect(demoKindOf(changedDaily), `daily sample set to ${per}`).toBe("daily");
    }
    expect(demoKindOf({ id: "" })).toBeNull();
    expect(demoKindOf({ id: 7 as unknown as string })).toBeNull();
  });
});
