import { describe, expect, it } from "vitest";
import {
  MAX_CARRY_DAYS,
  MAX_EXCURSION,
  PARTIAL_MONTH_DAYS,
  averageDailyVolume,
  buildReport,
  cleanLimit,
  coverage,
  defaultMonth,
  entriesPerDay,
  flagsForMonth,
  isJudged,
  isOutside,
  isReal,
  isValidDate,
  limitBreakdown,
  limitBreakdownText,
  limitFor,
  limitText,
  mergeSlots,
  meterSteps,
  monthStats,
  monthsOf,
  nearestIndex,
  niceTicks,
  physicalMaxFor,
  reportNotes,
  shortDate,
  sortLog,
  strayIdsFrom,
  summariseParam,
  suspectValuesFrom,
  thinForDrawing,
  trendSeries,
  undatedCount,
} from "../report";
import { ETP_STRENGTH_MAX, runChecks } from "../checks";
import { DEFAULT_LIMITS, LIMIT_PRESETS, PARAMS } from "../params";
import { buildDailySeed, buildSeed } from "../seed";
import type { Flag, LogEntry, ParamKey, Plant, ShiftCode } from "../types";

// All data below is made up for the tests. None of it comes from a real plant.

const shiftPlant: Plant = {
  id: "p3",
  name: "Test STP",
  kind: "STP",
  location: "",
  capacityKld: 250,
  technology: "MBBR",
  operatorCompany: "",
  consentNo: "",
  shiftsPerDay: 3,
  limits: DEFAULT_LIMITS.STP,
};

const dailyPlant: Plant = { ...shiftPlant, id: "p1", capacityKld: 50, shiftsPerDay: 1, limits: {} };

let counter = 0;
function E(date: string, shift: ShiftCode | null, values: LogEntry["values"] = {}, extra: Partial<LogEntry> = {}): LogEntry {
  counter++;
  return {
    id: `e${String(counter).padStart(5, "0")}`,
    plantId: "p",
    date,
    shift,
    time: null,
    operator: null,
    values,
    remarks: null,
    pageId: null,
    capturedAt: `${date}T15:00:00.000Z`,
    ...extra,
  };
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// A one-row-a-day meter-and-dosing register: totalisers rise by `perDay`.
function dailyRegister(from: string, days: number, startReading = 1000, perDay = 40): LogEntry[] {
  return Array.from({ length: days }, (_, i) =>
    E(addDays(from, i), null, {
      inletTotaliser: startReading + perDay * i,
      outletTotaliser: startReading - 100 + (perDay - 2) * i,
      runHours: 8,
      limeKg: 0.5,
      alumKg: 0.25,
      chlorineKg: 0.1,
      sludgeKg: i % 7 === 0 ? 12 : null,
      energyKwh: 5000 + 30 * i,
    }),
  );
}

// ------------------------------------------------------------------ basics

describe("dates, limits and plant settings", () => {
  it("accepts only real calendar dates", () => {
    expect(isValidDate("2026-09-30")).toBe(true);
    expect(isValidDate("2026-09-31")).toBe(false);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    // The rule engine only accepts 2000 to 2100; a year outside that is a slip.
    expect(isValidDate("1999-12-31")).toBe(false);
    expect(isValidDate("2000-01-01")).toBe(true);
    expect(isValidDate("2101-01-01")).toBe(false);
    expect(isValidDate("0026-09-01")).toBe(false);
    for (const bad of ["", "30-09-2026", "2026-9-3", "2026-13-01", "garbage", null, undefined, 20260930, {}]) {
      expect(isValidDate(bad), String(bad)).toBe(false);
    }
  });

  it("formats a short date and leaves non-dates alone", () => {
    expect(shortDate("2026-09-07")).toBe("7 Sep");
    expect(shortDate("someday")).toBe("someday");
    expect(shortDate(undefined as unknown as string)).toBe("");
  });

  it("treats NaN, infinities, text and out-of-range numbers as not real", () => {
    expect(isReal("phOutlet", 7.2)).toBe(true);
    expect(isReal("phOutlet", 0)).toBe(true);
    expect(isReal("phOutlet", 71)).toBe(false);
    expect(isReal("phOutlet", -1)).toBe(false);
    expect(isReal("phOutlet", NaN)).toBe(false);
    expect(isReal("phOutlet", Infinity)).toBe(false);
    expect(isReal("phOutlet", "7.2")).toBe(false);
    expect(isReal("phOutlet", null)).toBe(false);
  });

  it("cleans half-filled limits", () => {
    expect(cleanLimit({ min: 6.5, max: 9 })).toEqual({ min: 6.5, max: 9 });
    expect(cleanLimit({ min: NaN, max: 30 })).toEqual({ max: 30 });
    expect(cleanLimit({ min: "6.5" })).toBeNull();
    expect(cleanLimit({})).toBeNull();
    expect(cleanLimit(null)).toBeNull();
    expect(cleanLimit("30")).toBeNull();
    expect(limitFor(null, "bodOutlet")).toBeNull();
    expect(limitFor({ limits: undefined as unknown as Plant["limits"] }, "bodOutlet")).toBeNull();
    expect(limitFor(shiftPlant, "bodOutlet")).toEqual({ max: 30 });
    expect(limitText({ min: 6.5, max: 9 })).toBe("≥ 6.5, ≤ 9");
    expect(limitText(null)).toBe("–");
    expect(isOutside({ max: 30 }, 31)).toBe(true);
    expect(isOutside({ max: 30 }, 30)).toBe(false);
    expect(isOutside({ min: 6.5 }, 6)).toBe(true);
    expect(isOutside(null, 999)).toBe(false);
    expect(isOutside({ max: 30 }, NaN)).toBe(false);
  });

  it("reads an unexpected entries-per-day setting as three", () => {
    expect(entriesPerDay({ shiftsPerDay: 1 })).toBe(1);
    expect(entriesPerDay({ shiftsPerDay: 2 })).toBe(2);
    expect(entriesPerDay({ shiftsPerDay: 3 })).toBe(3);
    expect(entriesPerDay({ shiftsPerDay: 0 as unknown as 1 })).toBe(3);
    expect(entriesPerDay(null)).toBe(3);
  });

  it("sorts entries and survives broken ones", () => {
    const a = E("2026-09-02", "B");
    const b = E("2026-09-02", "A");
    const c = E("2026-09-01", null);
    const broken = { id: 7 } as unknown as LogEntry;
    const sorted = sortLog([a, null as unknown as LogEntry, b, broken, c]);
    expect(sorted.map((e) => e.id)).toEqual([7, c.id, b.id, a.id]);
    expect(sortLog(null)).toEqual([]);
    expect(sortLog("nope" as unknown as LogEntry[])).toEqual([]);
  });
});

// ------------------------------------------------------------------ months

describe("monthsOf", () => {
  it("is empty for an empty or missing log", () => {
    expect(monthsOf([])).toEqual([]);
    expect(monthsOf(null)).toEqual([]);
    expect(monthsOf(undefined)).toEqual([]);
  });

  it("lists each month once, newest first, whatever the input order", () => {
    const entries = [E("2026-09-15", "A"), E("2026-07-01", "A"), E("2026-10-02", "A"), E("2026-09-01", "B"), E("2025-12-31", "C")];
    expect(monthsOf(entries)).toEqual(["2026-10", "2026-09", "2026-07", "2025-12"]);
  });

  it("gives entries with an unreadable date no month, and counts them", () => {
    const entries = [E("2026-09-15", "A"), E("", "A"), E("15/09/2026", "A"), E("2026-02-30", "A"), { ...E("2026-09-16", "A"), date: undefined as unknown as string }];
    expect(monthsOf(entries)).toEqual(["2026-09"]);
    expect(undatedCount(entries)).toBe(4);
  });
});

// ---------------------------------------------------------- param summary

describe("summariseParam", () => {
  it("returns an empty summary for no rows", () => {
    expect(summariseParam([], "tssOutlet", { max: 100 })).toEqual({
      key: "tssOutlet", n: 0, min: null, mean: null, max: null, total: null, limit: { max: 100 }, outside: 0, judged: 0, excluded: 0, aboveCap: 0, setAside: 0,
    });
  });

  it("handles a single entry", () => {
    const s = summariseParam([E("2026-09-01", "A", { tssOutlet: 42 })], "tssOutlet", { max: 100 });
    expect(s).toMatchObject({ n: 1, min: 42, mean: 42, max: 42, outside: 0, excluded: 0, total: null });
  });

  it("leaves out NaN and impossible values and counts them", () => {
    const rows = [
      E("2026-09-01", "A", { phOutlet: 7.0 }),
      E("2026-09-01", "B", { phOutlet: 71 }), // missing decimal point
      E("2026-09-01", "C", { phOutlet: NaN }),
      E("2026-09-02", "A", { phOutlet: -3 }),
      E("2026-09-02", "B", { phOutlet: Infinity }),
      E("2026-09-02", "C", { phOutlet: "7.4" as unknown as number }),
      E("2026-09-03", "A", { phOutlet: 8.0 }),
      E("2026-09-03", "B", { phOutlet: null }),
      E("2026-09-03", "C", {}),
    ];
    const s = summariseParam(rows, "phOutlet", { min: 6.5, max: 9 });
    expect(s.n).toBe(2);
    expect(s.min).toBe(7);
    expect(s.max).toBe(8);
    expect(s.mean).toBeCloseTo(7.5, 10);
    expect(s.excluded).toBe(5);
    expect(s.outside).toBe(0);
  });

  it("counts readings outside either side of a limit, inclusive at the limit", () => {
    const rows = [6.4, 6.5, 7, 9, 9.1].map((v, i) => E("2026-09-01", (["A", "B", "C"] as ShiftCode[])[i % 3], { phOutlet: v }));
    expect(summariseParam(rows, "phOutlet", { min: 6.5, max: 9 }).outside).toBe(2);
  });

  it("reports no outside count when there is no usable limit", () => {
    const rows = [E("2026-09-01", "A", { codOutlet: 900 })];
    expect(summariseParam(rows, "codOutlet", undefined).outside).toBeNull();
    expect(summariseParam(rows, "codOutlet", null).outside).toBeNull();
    expect(summariseParam(rows, "codOutlet", { max: NaN }).outside).toBeNull();
    expect(summariseParam(rows, "codOutlet", { max: NaN }).limit).toBeNull();
  });

  it("totals only quantities where a total means something", () => {
    const rows = [E("2026-09-01", null, { limeKg: 0.1, phOutlet: 7 }), E("2026-09-02", null, { limeKg: 0.2, phOutlet: 7 })];
    expect(summariseParam(rows, "limeKg", null).total).toBe(0.3); // not 0.30000000000000004
    expect(summariseParam(rows, "phOutlet", null).total).toBeNull();
  });

  it("copes with thousands of rows and very large values", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => E("2026-09-01", "A", { sludgeKg: 1000000 - (i % 2) }));
    const s = summariseParam(rows, "sludgeKg", null);
    expect(s.n).toBe(5000);
    expect(s.max).toBe(1000000);
    expect(s.min).toBe(999999);
    expect(s.total).toBe(5000 * 1000000 - 2500);
  });
});

// ------------------------------------------------------------- merge slots

describe("mergeSlots", () => {
  it("folds two saves of the same date and shift; the later save wins and the difference is counted", () => {
    const first = E("2026-09-01", "A", { tssOutlet: 20, codOutlet: 60 }, { capturedAt: "2026-09-01T10:00:00.000Z", edited: ["tssOutlet"] });
    const second = E("2026-09-01", "A", { tssOutlet: 30, codOutlet: 60, bodOutlet: 9 }, { capturedAt: "2026-09-02T10:00:00.000Z", remarks: "retyped" });
    const other = E("2026-09-01", "B", { tssOutlet: 25 });
    // Given newest first, to show input order does not matter.
    const m = mergeSlots([second, other, first], 3);
    expect(m.rows).toHaveLength(2);
    expect(m.folded).toBe(1);
    expect(m.conflicts).toBe(1);
    const row = m.rows[0];
    expect(row.values).toEqual({ tssOutlet: 30, codOutlet: 60, bodOutlet: 9 });
    expect(row.id).toBe(second.id);
    expect(row.sourceIds).toEqual([first.id, second.id]);
    expect(row.edited).toEqual(["tssOutlet"]);
    expect(row.remarks).toBe("retyped");
    // The originals are not modified.
    expect(first.values.tssOutlet).toBe(20);
  });

  it("joins two facing pages of a daily register into one row per date", () => {
    const flows = E("2026-09-01", null, { inletTotaliser: 1000, outletTotaliser: 900 });
    const dosing = E("2026-09-01", null, { limeKg: 0.5, energyKwh: 5000 });
    const m = mergeSlots([flows, dosing], 1);
    expect(m.rows).toHaveLength(1);
    expect(m.conflicts).toBe(0);
    expect(m.folded).toBe(1);
    expect(m.rows[0].values).toEqual({ inletTotaliser: 1000, outletTotaliser: 900, limeKg: 0.5, energyKwh: 5000 });
  });

  it("at a shift plant, folds unlabelled rows only when they are identical", () => {
    const a = E("2026-09-01", null, { tssOutlet: 20, codOutlet: 60 });
    const copy = E("2026-09-01", null, { tssOutlet: 20, codOutlet: 60 });
    const different = E("2026-09-01", null, { tssOutlet: 22, codOutlet: 64 });
    const m = mergeSlots([a, copy, different], 3);
    expect(m.rows).toHaveLength(2);
    expect(m.folded).toBe(1);
    expect(m.conflicts).toBe(0);
  });

  it("never folds entries whose date cannot be read", () => {
    const m = mergeSlots([E("", null, { tssOutlet: 1 }), E("", null, { tssOutlet: 1 })], 1);
    expect(m.rows).toHaveLength(2);
    expect(m.folded).toBe(0);
  });

  it("returns nothing for nothing", () => {
    expect(mergeSlots(null, 3)).toEqual({ rows: [], folded: 0, conflicts: 0 });
    expect(mergeSlots([], 1)).toEqual({ rows: [], folded: 0, conflicts: 0 });
  });
});

// ------------------------------------------------------------ meter steps

describe("meterSteps", () => {
  const meter = (readings: (number | null)[]) =>
    meterSteps(readings.map((v, i) => E(addDays("2026-09-01", i), null, { energyKwh: v })), "energyKwh");
  const total = (readings: (number | null)[]) => meter(readings).reduce((s, x) => s + (x.increase ?? 0), 0);

  it("counts the increase from each reading to the next", () => {
    const steps = meter([100, 103, 106, 106, 110]);
    expect(steps.map((s) => s.increase)).toEqual([null, 3, 3, 0, 4]);
    expect(steps.map((s) => s.status)).toEqual(["first", "counted", "counted", "counted", "counted"]);
    expect(steps[1].since).toBe("2026-09-01");
    expect(steps[1].days).toBe(1);
  });

  it("returns nothing for no readings and one step for one reading", () => {
    expect(meter([])).toEqual([]);
    expect(meter([null, null])).toEqual([]);
    const one = meter([500]);
    expect(one).toHaveLength(1);
    expect(one[0].increase).toBeNull();
  });

  it("counts nothing for a fall and restarts from the new reading (meter replaced)", () => {
    const steps = meter([9000, 9010, 5, 12, 20]);
    expect(steps.map((s) => s.status)).toEqual(["first", "counted", "fall", "counted", "counted"]);
    expect(total([9000, 9010, 5, 12, 20])).toBe(10 + 7 + 8);
  });

  it("leaves out a single misread reading instead of counting a huge jump", () => {
    // 12340 is 1234 with a slipped digit; 124 has lost one.
    expect(total([1220, 1234, 12340, 1245, 1260])).toBe(40);
    expect(total([1220, 1234, 124, 1245, 1260])).toBe(40);
    expect(meter([1220, 1234, 124, 1245, 1260]).map((s) => s.status)).toEqual(["first", "counted", "outOfSequence", "counted", "counted"]);
  });

  it("sets aside a short run written too high, and counts across it", () => {
    // Five days where another column's figure was written in, then back.
    const readings = [1700, 1710, 3100, 3110, 3120, 3130, 3140, 1760, 1770];
    expect(total(readings)).toBe(70); // 1770 - 1700, not 1,400 more
    expect(meter(readings).map((s) => s.status)).toEqual([
      "first", "counted", "outOfSequence", "outOfSequence", "outOfSequence", "outOfSequence", "outOfSequence", "counted", "counted",
    ]);
    const back = meter(readings)[7];
    expect(back.increase).toBe(50);
    expect(back.since).toBe("2026-09-02");
    expect(back.days).toBe(6);
  });

  it("treats a lower reading after a long higher run as a fall, not as a week of misreads", () => {
    const high = Array.from({ length: MAX_EXCURSION + 1 }, (_, i) => 3100 + 10 * i);
    const steps = meter([1700, ...high, 1760, 1770]);
    expect(steps.filter((s) => s.status === "outOfSequence")).toHaveLength(0);
    expect(steps[steps.length - 2].status).toBe("fall");
  });

  it("never produces a negative increase, whatever the readings", () => {
    const wild = [50, 10, 10, 0, 99999999, 3, 7, 7, 2, 100, 1];
    for (const s of meter(wild)) expect(s.increase === null || s.increase >= 0, JSON.stringify(s.value)).toBe(true);
    expect(total(wild)).toBeGreaterThanOrEqual(0);
  });

  it("skips NaN, impossible and missing readings without breaking the sequence", () => {
    const steps = meter([100, NaN, -5, null, 2e9, 110]);
    expect(steps.map((s) => s.value)).toEqual([100, 110]);
    expect(steps[1].increase).toBe(10);
    expect(steps[1].days).toBe(5);
    expect(steps[1].index).toBe(5);
  });
});

// --------------------------------------------------------------- coverage

describe("coverage", () => {
  it("is empty for no dated rows", () => {
    expect(coverage([], 3)).toMatchObject({ days: [], recorded: 0, expected: 0, totalDays: 0, firstDate: null });
    expect(coverage([E("", "A")], 3).days).toEqual([]);
    expect(coverage(null, 1).expected).toBe(0);
  });

  it("gives a one-entry-a-day register one slot per day, filled by any entry", () => {
    const rows = [E("2026-09-01", null), E("2026-09-02", "B"), E("2026-09-04", null)];
    const c = coverage(rows, 1);
    expect(c.days.map((d) => d.slots)).toEqual([[true], [true], [false], [true]]);
    expect(c.recorded).toBe(3);
    expect(c.expected).toBe(4);
  });

  it("fills shift slots by letter, then by unlabelled rows in order", () => {
    const rows = [E("2026-09-01", "A"), E("2026-09-01", "C"), E("2026-09-02", null), E("2026-09-02", null)];
    const c = coverage(rows, 3);
    expect(c.days.map((d) => d.slots)).toEqual([[true, false, true], [true, true, false]]);
    expect(c.recorded).toBe(4);
    // The third shift of the last day has not been worked yet: it is not expected.
    expect(c.days.map((d) => d.expected)).toEqual([[true, true, true], [true, true, false]]);
    expect(c.expected).toBe(5);
  });

  it("never records more than the day can hold", () => {
    const rows = Array.from({ length: 7 }, () => E("2026-09-01", null));
    expect(coverage(rows, 3).recorded).toBe(3);
  });

  it("keeps only the latest days of a long record, but counts all of it", () => {
    const rows = Array.from({ length: 100 }, (_, i) => E(addDays("2026-06-01", i), null)).filter((_, i) => i !== 50);
    const c = coverage(rows, 1, 30);
    expect(c.truncated).toBe(true);
    expect(c.days).toHaveLength(30);
    expect(c.days[29].date).toBe(addDays("2026-06-01", 99));
    expect(c.totalDays).toBe(100);
    expect(c.expected).toBe(100);
    expect(c.recorded).toBe(99);
  });

  it("does not count twenty years of missing days for one mistyped year", () => {
    const rows = [E("2006-09-01", "A"), E("2026-09-29", "A"), E("2026-09-30", "A")];
    const c = coverage(rows, 1, 30);
    expect(c.strays).toBe(1);
    expect(c.recorded).toBe(2);
    expect(c.expected).toBe(2);
    expect(c.totalDays).toBe(2);
    expect(c.firstDate).toBe("2026-09-29");
    expect(c.truncated).toBe(false);
    expect(c.days.map((d) => d.date)).toEqual(["2026-09-29", "2026-09-30"]);
  });

  it("does not expect the shifts before the first entry or after the latest one", () => {
    // The normal state of a plant in the middle of a day: 1 Sep C, 2 Sep A/B/C, 3 Sep A.
    const rows = [E("2026-09-01", "C"), E("2026-09-02", "A"), E("2026-09-02", "B"), E("2026-09-02", "C"), E("2026-09-03", "A")];
    const c = coverage(rows, 3);
    expect(c.recorded).toBe(5);
    expect(c.expected).toBe(5);
    expect(c.days.map((d) => d.expected)).toEqual([[false, false, true], [true, true, true], [true, false, false]]);
    // A shift missing inside the record is still missing.
    const longer = [...rows, E("2026-09-03", "B"), E("2026-09-03", "C"), E("2026-09-04", "A")];
    const gap = coverage(longer.filter((_, i) => i !== 2), 3); // without 2 Sep, shift B
    expect(gap.recorded).toBe(7);
    expect(gap.expected).toBe(8);
    expect(gap.days[1].slots).toEqual([true, false, true]);
    expect(gap.days[1].expected).toEqual([true, true, true]);
  });

  it("counts a long break once, not day by day", () => {
    const rows = [...dailyRegister("2026-01-01", 10), ...dailyRegister("2026-06-01", 10)];
    const c = coverage(rows, 1, 400);
    expect(c.breaks).toBe(1);
    expect(c.recorded).toBe(20);
    expect(c.expected).toBe(20);
    // The days of the break are in the strip, but none of them is expected.
    const inBreak = c.days.filter((d) => d.date > "2026-01-10" && d.date < "2026-06-01");
    expect(inBreak.length).toBeGreaterThan(100);
    expect(inBreak.every((d) => d.expected.every((x) => !x) && d.slots.every((x) => !x))).toBe(true);
  });

  it("does not expect a shift that no day of the register has", () => {
    // A two-shift register kept at a plant set to three shifts a day.
    const rows = Array.from({ length: 10 }, (_, i) => [E(addDays("2026-09-01", i), "A"), E(addDays("2026-09-01", i), "B")]).flat();
    const c = coverage(rows, 3);
    expect(c.recorded).toBe(20);
    expect(c.expected).toBe(20);
    expect(c.days[4].expected).toEqual([true, true, false]);
  });

  it("leaves out the entries the date rule set aside", () => {
    const rows = [...dailyRegister("2026-09-01", 10), E("2026-09-25", null)];
    const stray = rows[rows.length - 1];
    const flag = { ruleId: "date", entryIds: [stray.id] } as Flag;
    const merged = mergeSlots(rows, 1).rows;
    expect(coverage(merged, 1).expected).toBe(25); // on distance alone, 25 Sep is the end of the record
    const c = coverage(merged, 1, 400, strayIdsFrom([flag]));
    expect(c.strays).toBe(1);
    expect(c.recorded).toBe(10);
    expect(c.expected).toBe(10);
    expect(c.lastDate).toBe("2026-09-10");
    expect(strayIdsFrom(null).size).toBe(0);
    expect(strayIdsFrom([null, { ruleId: "date" }, { ruleId: "limit", entryIds: ["x"] }] as unknown as Flag[]).size).toBe(0);
  });

  it("gives the same count as the missing-entries rule of the checks", () => {
    const cases: { name: string; plant: Plant; entries: LogEntry[] }[] = [
      { name: "3-shift sample", ...buildSeed("2026-09-27") },
      { name: "daily sample", ...buildDailySeed("2026-09-20") },
      {
        name: "mid-day",
        plant: shiftPlant,
        entries: [E("2026-09-01", "C"), E("2026-09-02", "A"), E("2026-09-02", "B"), E("2026-09-02", "C"), E("2026-09-03", "A")],
      },
      {
        name: "mistyped year",
        plant: shiftPlant,
        entries: [E("2006-09-01", "A"), ...["A", "B", "C"].flatMap((s) => [E("2026-09-01", s as ShiftCode), E("2026-09-02", s as ShiftCode)])],
      },
      { name: "month-edge gap", plant: dailyPlant, entries: [...dailyRegister("2026-09-01", 25), ...dailyRegister("2026-10-01", 5, 3000)] },
      { name: "long break", plant: dailyPlant, entries: [...dailyRegister("2026-01-01", 10), ...dailyRegister("2026-06-01", 10, 9000)] },
      // Registers that do not match the plant setting.
      {
        name: "two shifts a day at a plant set to three",
        plant: shiftPlant,
        entries: Array.from({ length: 10 }, (_, i) => [E(addDays("2026-09-01", i), "A", { phOutlet: 7 + (i % 4) / 10 }), E(addDays("2026-09-01", i), "B", { phOutlet: 7.1 + (i % 3) / 10 })]).flat(),
      },
      {
        name: "one unlabelled row a day at a plant set to three",
        plant: shiftPlant,
        entries: Array.from({ length: 10 }, (_, i) => E(addDays("2026-09-01", i), null, { phOutlet: 7 + (i % 4) / 10 })),
      },
      {
        name: "three rows a day at a plant set to one",
        plant: dailyPlant,
        entries: Array.from({ length: 10 }, (_, i) => (["A", "B", "C"] as ShiftCode[]).map((s) => E(addDays("2026-09-01", i), s, { phOutlet: 7 + (i % 4) / 10 }))).flat(),
      },
      {
        name: "clock times instead of shift letters",
        plant: shiftPlant,
        entries: Array.from({ length: 6 }, (_, i) => ["08:00", "16:00", "23:30"].map((time) => E(addDays("2026-09-01", i), null, { phOutlet: 7 + (i % 4) / 10 }, { time }))).flat(),
      },
      {
        name: "a gap of four weeks inside the record",
        plant: dailyPlant,
        entries: [...Array.from({ length: 12 }, (_, i) => E(addDays("2026-09-01", i), null, { phOutlet: 7 })), E("2026-10-11", null, { phOutlet: 7 })],
      },
    ];
    for (const c of cases) {
      const perDay = entriesPerDay(c.plant);
      const checks = runChecks(c.plant, c.entries);
      const cov = coverage(mergeSlots(c.entries, perDay).rows, perDay, 400, strayIdsFrom(checks.flags));
      expect([cov.recorded, cov.expected], c.name).toEqual([checks.recordedShifts, checks.expectedShifts]);
    }
  });
});

// ------------------------------------------------- report: daily register

describe("buildReport for a one-row-a-day meter register", () => {
  it("takes volumes and energy from the differences of the meter readings", () => {
    const entries = dailyRegister("2026-09-01", 30);
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(r.perDay).toBe(1);
    expect(r.recorded).toBe(30);
    expect(r.expected).toBe(30);
    // 29 increases between 30 readings: no reading from before the month.
    expect(r.inflow).toEqual({ value: 29 * 40, source: "meter" });
    expect(r.outflow).toEqual({ value: 29 * 38, source: "meter" });
    expect(r.energyUsed).toBe(29 * 30);
    const inlet = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(inlet).toMatchObject({ readings: 30, first: 1000, last: 1000 + 29 * 40, from: "2026-09-01", to: "2026-09-30", carriedIn: false, falls: 0 });
    expect(reportNotes(r).join(" ")).toContain("No usable reading was taken in the 3 days before the month");
    expect(reportNotes(r).join(" ")).not.toContain("reading readings");
  });

  it("starts from the last reading of the previous month when it is close enough", () => {
    const entries = dailyRegister("2026-08-30", 32); // 30 Aug .. 30 Sep
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(r.inflow?.value).toBe(30 * 40);
    const inlet = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(inlet.carriedIn).toBe(true);
    expect(inlet.from).toBe("2026-08-31");
    // August's own report does not include September.
    const aug = buildReport(dailyPlant, entries, "2026-08");
    expect(aug.inflow?.value).toBe(40);
    expect(aug.daily).toHaveLength(2);
  });

  it("counts across readings that were set aside at the start of the month", () => {
    // 31 Aug is a good reading; 1 to 4 Sep carry another column's figure.
    const entries = dailyRegister("2026-08-28", 12, 1000, 10); // 28 Aug .. 8 Sep
    for (let i = 4; i < 8; i++) entries[i].values.inletTotaliser = 50000 + i;
    const r = buildReport(dailyPlant, entries, "2026-09");
    const inlet = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(inlet.outOfSequence).toBe(4);
    expect(inlet.carriedIn).toBe(true);
    expect(inlet.from).toBe("2026-08-31");
    expect(r.inflow?.value).toBe(80); // 8 Sep minus 31 Aug, eight days at 10
    expect(r.daily[4].cells.inVolume).toBe(50); // 5 Sep carries the five days since 31 Aug
  });

  it("does not start from a reading that is too far back", () => {
    const old = E("2026-08-01", null, { inletTotaliser: 10 });
    const entries = [old, ...dailyRegister("2026-09-05", 3, 5000)];
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(MAX_CARRY_DAYS).toBeLessThan(35);
    expect(r.inflow?.value).toBe(80); // not 4990 + 80
    expect(r.meters.find((m) => m.key === "inletTotaliser")!.carriedIn).toBe(false);
  });

  it("shows meter readings, daily volume, run hours, dosing and energy per day", () => {
    const r = buildReport(dailyPlant, dailyRegister("2026-09-01", 5), "2026-09");
    expect(r.columns.map((c) => c.id)).toEqual([
      "inMeter", "inVolume", "outMeter", "outVolume", "runHours", "lime", "alum", "chlorine", "sludge", "energyMeter", "energyUsed",
    ]);
    // One entry a day: no "avg"/"max" wording in the headings.
    for (const c of r.columns) expect(c.sub, c.id).not.toMatch(/avg|max/);
    expect(r.daily[0].cells).toMatchObject({ inMeter: 1000, inVolume: null, runHours: 8, lime: 0.5, sludge: 12, energyMeter: 5000, energyUsed: null });
    expect(r.daily[1].cells).toMatchObject({ inMeter: 1040, inVolume: 40, outVolume: 38, sludge: null, energyUsed: 30 });
    expect(r.totals).toMatchObject({ inVolume: 160, outVolume: 152, runHours: 40, lime: 2.5, alum: 1.25, chlorine: 0.5, sludge: 12, energyUsed: 120 });
    expect(r.totals.inMeter).toBeUndefined(); // a total of meter readings would be nonsense
    const lime = r.summaries.find((s) => s.key === "limeKg")!;
    expect(lime.total).toBe(2.5);
    expect(r.summaries.find((s) => s.key === "sludgeKg")!.total).toBe(12);
    // Lab parameters that were never entered get no row and no column.
    expect(r.summaries.some((s) => s.key === "bodOutlet")).toBe(false);
  });

  it("handles a meter that is replaced part-way through the month", () => {
    const entries = dailyRegister("2026-09-01", 10);
    for (let i = 5; i < 10; i++) entries[i].values.inletTotaliser = 3 + 40 * (i - 5); // new meter from day 6
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(r.inflow?.value).toBe(4 * 40 + 4 * 40);
    const inlet = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(inlet.falls).toBe(1);
    expect(r.daily[5].cells.inVolume).toBeNull();
    expect(reportNotes(r).join(" ")).toMatch(/went down once/);
  });

  it("keeps energy at zero or above even when the meter only falls", () => {
    const entries = [500, 400, 300, 200].map((v, i) => E(addDays("2026-09-01", i), null, { energyKwh: v }));
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(r.energyUsed).toBeNull(); // nothing could be counted; shown as unknown, never negative
    expect(r.meters[0].falls).toBe(3);
    for (const d of r.daily) expect(d.cells.energyUsed === null || d.cells.energyUsed >= 0).toBe(true);
    expect(reportNotes(r).join(" ")).toContain("could not be worked out");
  });

  it("does not count a page twice when it was saved twice", () => {
    const once = dailyRegister("2026-09-01", 10);
    const again = once.map((e) => ({ ...e, id: `${e.id}-again`, capturedAt: "2026-09-12T08:00:00.000Z" }));
    const r = buildReport(dailyPlant, [...once, ...again], "2026-09");
    const single = buildReport(dailyPlant, once, "2026-09");
    expect(r.totals).toEqual(single.totals);
    expect(r.recorded).toBe(10);
    expect(r.folded).toBe(10);
    expect(r.conflicts).toBe(0);
    expect(reportNotes(r).join(" ")).toContain("combined into one row");
  });

  it("lists a day with no entry between the first and last date", () => {
    const entries = dailyRegister("2026-09-01", 5).filter((_, i) => i !== 2);
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(r.daily.map((d) => d.entries)).toEqual([1, 1, 0, 1, 1]);
    expect(r.recorded).toBe(4);
    expect(r.expected).toBe(5);
    // The increase across the gap is shown against the later date and noted.
    expect(r.daily[3].cells.inVolume).toBe(80);
    expect(r.inflow?.value).toBe(160);
    expect(reportNotes(r).join(" ")).toContain("more than one day");
  });
});

// ------------------------------------------------- report: shift register

describe("buildReport for a three-shift lab register", () => {
  const SH: ShiftCode[] = ["A", "B", "C"];
  const month = (days: number) =>
    Array.from({ length: days * 3 }, (_, i) =>
      E(addDays("2026-09-01", Math.floor(i / 3)), SH[i % 3], {
        inletFlow: 80,
        outletFlow: 75,
        phOutlet: 7 + (i % 3) * 0.2,
        codOutlet: 60 + (i % 3) * 10,
        tssOutlet: 20,
        blowerHours: 6.5,
        energyKwh: 10000 + 80 * i,
      }),
    );

  it("sums flows, averages and maxima per day, and counts entries", () => {
    const r = buildReport(shiftPlant, month(4), "2026-09");
    expect(r.recorded).toBe(12);
    expect(r.expected).toBe(12);
    expect(r.inflow).toEqual({ value: 960, source: "entries" });
    expect(r.outflow).toEqual({ value: 900, source: "entries" });
    expect(r.energyUsed).toBe(80 * 11);
    expect(r.columns.map((c) => c.id)).toEqual(["inflow", "outflow", "ph", "cod", "tss", "blower", "energyMeter", "energyUsed"]);
    expect(r.columns.find((c) => c.id === "ph")!.sub).toBe("avg");
    expect(r.columns.find((c) => c.id === "cod")!.sub).toBe("max mg/L");
    const d = r.daily[1];
    expect(d.entries).toBe(3);
    expect(d.cells.inflow).toBe(240);
    expect(d.cells.ph).toBeCloseTo(7.2, 10);
    expect(d.cells.cod).toBe(80);
    expect(d.cells.blower).toBe(19.5);
    expect(d.cells.energyUsed).toBe(240);
    expect(d.cells.energyMeter).toBe(10000 + 80 * 5); // the day's closing reading, not its first
    expect(d.recorded).toBe(3);
    expect(d.expected).toBe(3);
    expect(d.partial).toEqual([]);
    expect(r.daily[0].cells.energyUsed).toBe(160); // the first reading has nothing before it
    const cod = r.summaries.find((s) => s.key === "codOutlet")!;
    expect(cod).toMatchObject({ n: 12, min: 60, max: 80, outside: 0, limit: { max: 250 } });
    expect(cod.mean).toBeCloseTo(70, 10);
  });

  it("marks a day from its readings, not from its average", () => {
    const entries = month(1);
    entries[0].values.phOutlet = 9.4; // outside 6.5 to 9.0
    entries[1].values.phOutlet = 6.6;
    entries[2].values.phOutlet = 6.6; // day average 7.53, inside the limit
    const r = buildReport(shiftPlant, entries, "2026-09");
    expect(r.daily[0].outside).toContain("ph");
    expect(r.summaries.find((s) => s.key === "phOutlet")!.outside).toBe(1);
  });

  it("treats a recorded zero as a reading, not as missing", () => {
    const entries = month(1);
    for (const e of entries) e.values.inletFlow = 0;
    const r = buildReport(shiftPlant, entries, "2026-09");
    expect(r.daily[0].cells.inflow).toBe(0);
    expect(r.inflow).toEqual({ value: 0, source: "entries" });
  });

  it("uses the later of two entries for one shift and says so", () => {
    const entries = month(2);
    const dup = { ...entries[0], id: "dup", values: { ...entries[0].values, tssOutlet: 150, inletFlow: 80 }, capturedAt: "2026-09-09T00:00:00.000Z" };
    const r = buildReport(shiftPlant, [dup, ...entries], "2026-09");
    expect(r.recorded).toBe(6);
    expect(r.inflow?.value).toBe(480); // 6 shifts, not 7
    expect(r.folded).toBe(1);
    expect(r.conflicts).toBe(1);
    expect(r.summaries.find((s) => s.key === "tssOutlet")!).toMatchObject({ n: 6, max: 150, outside: 1 });
    expect(reportNotes(r).join(" ")).toContain("most recently saved");
  });

  it("gives the same result whatever order the entries arrive in", () => {
    const entries = month(5);
    const shuffled = [...entries].sort((a, b) => (a.id.split("").reverse().join("") < b.id.split("").reverse().join("") ? -1 : 1));
    const a = buildReport(shiftPlant, entries, "2026-09");
    const b = buildReport(shiftPlant, shuffled, "2026-09");
    expect(b.daily).toEqual(a.daily);
    expect(b.totals).toEqual(a.totals);
    expect(b.summaries).toEqual(a.summaries);
    expect(b.meters).toEqual(a.meters);
  });

  it("leaves impossible values out of every figure and counts them", () => {
    const entries = month(1);
    entries[1].values.phOutlet = 71;
    entries[2].values.codOutlet = NaN;
    entries[2].values.energyKwh = -4;
    const r = buildReport(shiftPlant, entries, "2026-09");
    expect(r.excluded).toBe(3);
    expect(r.summaries.find((s) => s.key === "phOutlet")!).toMatchObject({ n: 2, excluded: 1 });
    expect(r.daily[0].cells.ph).toBeCloseTo(7.2, 10);
    expect(r.daily[0].cells.cod).toBe(70);
    expect(r.energyUsed).toBe(80);
    expect(reportNotes(r).join(" ")).toContain("3 values outside the physically possible range");
  });

  it("works on the bundled sample plant, whose energy meter has a planted misread", () => {
    const { plant, entries } = buildSeed("2026-09-27");
    const r = buildReport(plant, entries, "2026-09");
    // The figures the sample plant's September report shows. A change that
    // moves any of them must be meant.
    expect([r.recorded, r.expected]).toEqual([79, 81]);
    expect(r.inflow).toEqual({ value: 6252, source: "entries" });
    expect(r.outflow).toEqual({ value: 5962, source: "entries" });
    expect(r.energyUsed).toBe(6647);
    expect(r.summaries.find((s) => s.key === "codOutlet")!.outside).toBe(1);
    expect(r.summaries.find((s) => s.key === "tssOutlet")!.outside).toBe(3);
    expect(r.summaries.find((s) => s.key === "bodOutlet")!.outside).toBe(0);
    expect(r.generated).toBe(r.rows.length);
    expect(r.corrected).toBe(0);
    const energy = r.meters.find((m) => m.key === "energyKwh")!;
    expect(energy.outOfSequence).toBe(1);
    expect(energy.falls).toBe(0);
    // The misread is bridged, not counted: the total is the last reading of the
    // month minus the reading the count starts from (31 Aug, carried in).
    expect(energy.carriedIn).toBe(true);
    const startReading = Math.max(...entries.filter((e) => e.date === "2026-08-31").map((e) => e.values.energyKwh ?? 0));
    expect(r.energyUsed).toBe((energy.last as number) - startReading);
    expect(r.totals.energyUsed).toBe(r.energyUsed);
    // Two shifts are missing, and the volumes are sums of entries: the notes say so.
    expect(reportNotes(r).join(" ")).toContain("sum of the 79 shift entries on record. 2 expected entries are missing");
    const aug = buildReport(plant, entries, "2026-08");
    expect([aug.recorded, aug.expected]).toEqual([9, 9]);
    expect([aug.inflow?.value, aug.outflow?.value, aug.energyUsed]).toEqual([720, 679, 677]);
    for (const d of r.daily) expect(d.cells.energyUsed === null || (d.cells.energyUsed >= 0 && d.cells.energyUsed < 1000), d.date).toBe(true);
    expect(r.summaries.find((s) => s.key === "phOutlet")!.excluded).toBe(1); // the planted pH 71
  });
});

// ------------------------------------------- report: bundled sample plants

describe("buildReport on the bundled daily sample register", () => {
  it("shows these figures for the sample plant", () => {
    const { plant, entries } = buildDailySeed("2026-09-20");
    const sep = buildReport(plant, entries, "2026-09");
    expect([sep.recorded, sep.expected]).toEqual([20, 20]);
    expect(sep.inflow).toEqual({ value: 162, source: "meter" });
    expect(sep.outflow).toEqual({ value: 153, source: "meter" });
    expect(sep.energyUsed).toBe(219);
    const aug = buildReport(plant, entries, "2026-08");
    expect([aug.recorded, aug.expected]).toEqual([25, 26]);
    expect([aug.inflow?.value, aug.outflow?.value, aug.energyUsed]).toEqual([195, 184, 270]);
    expect(aug.daily).toHaveLength(26);
    expect(aug.daily.filter((d) => d.entries === 0)).toHaveLength(1);
  });

  it("gives believable volumes and energy despite the planted meter problems", () => {
    const { plant, entries } = buildDailySeed("2026-09-20");
    expect(entriesPerDay(plant)).toBe(1);
    for (const month of monthsOf(entries)) {
      const r = buildReport(plant, entries, month);
      expect(r.recorded, month).toBeGreaterThan(0);
      expect(r.recorded, month).toBeLessThanOrEqual(r.expected);
      for (const m of r.meters) expect(m.total === null || m.total >= 0, `${month} ${m.key}`).toBe(true);
      // A plant of this size cannot pass many times its design capacity per day.
      const days = r.daily.length;
      for (const v of [r.inflow, r.outflow]) {
        if (v) expect(v.value / days, `${month} ${JSON.stringify(v)}`).toBeLessThan(plant.capacityKld * 3);
      }
      for (const d of r.daily) {
        for (const id of ["inVolume", "outVolume", "energyUsed"]) {
          const c = d.cells[id];
          expect(c === null || c === undefined || c >= 0, `${d.date} ${id} ${c}`).toBe(true);
        }
      }
      expect(() => reportNotes(r)).not.toThrow();
    }
  });
});

// --------------------------------------------------- report: hostile input

describe("buildReport with hostile input", () => {
  it("returns an empty report for an empty month", () => {
    const r = buildReport(shiftPlant, [E("2026-08-31", "A", { tssOutlet: 20 })], "2026-09");
    expect(r.rows).toEqual([]);
    expect(r.daily).toEqual([]);
    expect(r.columns).toEqual([]);
    expect(r.summaries).toEqual([]);
    expect(r.meters).toEqual([]);
    expect(r.inflow).toBeNull();
    expect(r.outflow).toBeNull();
    expect(r.energyUsed).toBeNull();
    expect(r.recorded).toBe(0);
    expect(r.expected).toBe(0);
    expect(r.firstDate).toBeNull();
    expect(reportNotes(r)).toEqual([]);
  });

  it("does not throw on missing plant, missing limits, missing entries or a nonsense month", () => {
    expect(() => buildReport(null, null, "2026-09")).not.toThrow();
    expect(() => buildReport(undefined, undefined, "")).not.toThrow();
    expect(() => buildReport({ ...shiftPlant, limits: undefined as unknown as Plant["limits"] }, [E("2026-09-01", "A", { bodOutlet: 99 })], "2026-09")).not.toThrow();
    const r = buildReport({ ...shiftPlant, limits: null as unknown as Plant["limits"] }, [E("2026-09-01", "A", { bodOutlet: 99 })], "2026-09");
    expect(r.summaries[0]).toMatchObject({ key: "bodOutlet", limit: null, outside: null });
    expect(r.daily[0].outside).toEqual([]);
    expect(buildReport(shiftPlant, [E("2026-09-01", "A")], "not-a-month").rows).toEqual([]);
  });

  it("handles a single entry", () => {
    const r = buildReport(dailyPlant, [E("2026-09-14", null, { inletTotaliser: 4200, limeKg: 0.5 })], "2026-09");
    expect(r.recorded).toBe(1);
    expect(r.expected).toBe(1);
    expect(r.daily).toHaveLength(1);
    expect(r.inflow).toBeNull(); // one reading gives no difference
    expect(r.columns.map((c) => c.id)).toEqual(["inMeter", "lime"]);
    expect(reportNotes(r)[0]).toContain("only one");
  });

  it("survives entries with broken shapes", () => {
    const broken = [
      null,
      undefined,
      42,
      { id: "x1", date: "2026-09-01" },
      { id: "x2", date: "2026-09-01", shift: "Z", values: null },
      { id: "x3", date: "2026-09-02", shift: null, values: "oops", edited: "phOutlet", remarks: 12 },
      { id: "x4", date: 20260903, values: { tssOutlet: 5 } },
      E("2026-09-03", "A", { tssOutlet: 40 }),
    ] as unknown as LogEntry[];
    const r = buildReport(shiftPlant, broken, "2026-09");
    expect(r.rows.length).toBe(4);
    expect(r.summaries.map((s) => s.key)).toEqual(["tssOutlet"]);
    expect(r.summaries[0].n).toBe(1);
    expect(r.corrected).toBe(0);
    expect(r.remarks).toEqual([]);
    expect(() => reportNotes(r)).not.toThrow();
  });

  it("stays finite with very large values", () => {
    const entries = [1e9, 1e9, 1e9].map((v, i) => E(addDays("2026-09-01", i), null, { inletTotaliser: v, sludgeKg: 1e6, limeKg: 1e4 }));
    entries[0].values.inletTotaliser = 0;
    const r = buildReport(dailyPlant, entries, "2026-09");
    expect(r.inflow?.value).toBe(1e9);
    expect(r.totals.sludge).toBe(3e6);
    for (const v of Object.values(r.totals)) expect(v === null || Number.isFinite(v)).toBe(true);
  });

  it("keeps operator remarks, and does not call an edit to a hand-typed entry a page correction", () => {
    const entries = [
      E("2026-09-01", "A", { tssOutlet: 20 }, { edited: ["tssOutlet", "codOutlet"], remarks: "  Blower tripped " }),
      E("2026-09-01", "B", { tssOutlet: 20 }, { remarks: "   " }),
    ];
    const r = buildReport(shiftPlant, entries, "2026-09");
    expect(r.corrected).toBe(0); // pageId is null: nothing here was read from a photographed page
    expect(r.remarks).toEqual([{ id: entries[0].id, date: "2026-09-01", shift: "A", text: "Blower tripped" }]);
  });

  it("counts as corrected only values that differ from what was first read from the page", () => {
    const high = "high" as const;
    const fromPage = E(
      "2026-09-01", "B",
      { phOutlet: 7.4, codOutlet: 80, limeKg: 0.5, runHours: 6, tssOutlet: 30, mlss: 3200 },
      {
        pageId: "page-1",
        edited: ["phOutlet", "codOutlet", "limeKg", "runHours", "tssOutlet", "bodOutlet", "mlss"],
        cellMeta: {
          phOutlet: { raw: "7.4", confidence: high }, // retyped, same value
          codOutlet: { raw: "60", confidence: "low" }, // 60 on the page, 80 saved: a correction
          limeKg: { raw: "500 g", confidence: high }, // grams on the page, kilograms stored: unchanged
          runHours: { raw: "9 am - 3 pm", confidence: "low" }, // cannot be rebuilt: the mark is taken at its word
          mlss: { raw: "3,200", confidence: high }, // digit grouping, same value
          // tssOutlet: nothing was read, a person typed 30 in: a correction
          // bodOutlet: marked, but nothing was read and nothing is saved
        },
      },
    );
    const entries = [
      E("2026-09-01", "A", { phOutlet: 7.2 }, { pageId: "seed", edited: ["phOutlet"] }),
      fromPage,
      E("2026-09-01", "C", { phOutlet: 7 }, { pageId: null, edited: ["phOutlet", "doAeration"] }),
    ];
    const r = buildReport(shiftPlant, entries, "2026-09");
    expect(r.corrected).toBe(3);
    expect(r.generated).toBe(1);
    // A page recorded as a sample reading is generated data too, and its
    // edits are not corrections of a register.
    const r2 = buildReport(shiftPlant, entries, "2026-09", { isGenerated: (e) => e.pageId === "seed" || e.pageId === "page-1" });
    expect(r2.generated).toBe(2);
    expect(r2.corrected).toBe(0);
    // A predicate that throws must not take the report down.
    const r3 = buildReport(shiftPlant, entries, "2026-09", { isGenerated: () => { throw new Error("boom"); } });
    expect(r3.generated).toBe(0);
    expect(r3.rows).toHaveLength(3);
  });
});

// ------------------------------------------- one rule for what is a reading

describe("readings, limits and the plant kind", () => {
  it("lets an ETP show strengths an STP cannot, as the checks do", () => {
    expect(physicalMaxFor("STP", "codOutlet")).toBe(PARAMS.codOutlet.physicalMax);
    expect(physicalMaxFor("ETP", "codOutlet")).toBe(ETP_STRENGTH_MAX);
    expect(physicalMaxFor("ETP", "phOutlet")).toBe(14);
    expect(physicalMaxFor(undefined, "codOutlet")).toBe(PARAMS.codOutlet.physicalMax);
    expect(isReal("codOutlet", 6000, "STP")).toBe(false);
    expect(isReal("codOutlet", 6000, "ETP")).toBe(true);
    expect(isJudged("codOutlet", 6000, "STP")).toBe(true); // a slip or a very large exceedance: still judged
    expect(isJudged("codOutlet", -4, "STP")).toBe(false);
    expect(isJudged("phOutlet", 71, "STP")).toBe(false);
    expect(isJudged("codOutlet", NaN, "ETP")).toBe(false);
    expect(isJudged("codOutlet", "60", "ETP")).toBe(false);
  });

  for (const kind of ["STP", "ETP"] as const) {
    it(`counts a COD of 6000 at an ${kind} the way the limit rule does`, () => {
      const plant: Plant = { ...shiftPlant, kind, shiftsPerDay: 1, limits: { codOutlet: { max: 250 } } };
      const entries = [60, 70, 6000, 80].map((v, i) => E(addDays("2026-09-01", i), null, { codOutlet: v }));
      const checks = runChecks(plant, entries);
      const flagged = checks.flags
        .filter((f) => f.ruleId === "limit" && f.param === "codOutlet")
        .reduce((n, f) => n + f.entryIds.length, 0);
      expect(flagged).toBe(1);
      const r = buildReport(plant, entries, "2026-09");
      const s = r.summaries.find((x) => x.key === "codOutlet")!;
      // The summary, the daily record, the tile and the flags all say one reading is outside.
      expect(s.outside).toBe(flagged);
      expect(s.judged).toBe(4);
      expect(limitBreakdown(plant, r.rows).rate).toBe(checks.complianceRate);
      expect(limitBreakdown(plant, r.rows).rate).toBe(0.75);
      expect(r.daily[2].outside).toEqual(["cod"]);
      expect(r.daily[2].cells.cod).toBe(6000);
      const trend = trendSeries(r.rows, "codOutlet", { kind, perDay: 1 });
      const notes = reportNotes(r).join(" ");
      expect(notes).not.toContain("physically possible");
      expect(trend.skipped).toBe(0);
      if (kind === "ETP") {
        // An effluent can honestly read 6000: it is a reading like any other.
        expect(s).toMatchObject({ n: 4, max: 6000, excluded: 0, aboveCap: 0 });
        expect(trend.points.map((p) => p.v)).toEqual([60, 70, 6000, 80]);
        expect(trend.aboveCap).toEqual([]);
        expect(notes).not.toContain("higher than a plant of this kind");
      } else {
        // At an STP it is a slip or a very large exceedance: out of the statistics and the chart, still judged.
        expect(s).toMatchObject({ n: 3, max: 80, excluded: 1, aboveCap: 1 });
        expect(s.mean).toBeCloseTo(70, 10);
        expect(trend.points.map((p) => p.v)).toEqual([60, 70, 80]);
        expect(trend.aboveCap.map((a) => a.v)).toEqual([6000]);
        expect(notes).toContain("1 outlet reading (COD) is higher than a plant of this kind would normally show");
      }
    });
  }

  it("matches the limit flags reading for reading on the 3-shift sample", () => {
    const { plant, entries } = buildSeed("2026-09-27");
    const checks = runChecks(plant, entries);
    const rows = mergeSlots(entries, 3).rows;
    for (const k of ["phOutlet", "codOutlet", "bodOutlet", "tssOutlet"] as ParamKey[]) {
      const flagged = checks.flags.filter((f) => f.ruleId === "limit" && f.param === k).reduce((n, f) => n + f.entryIds.length, 0);
      expect(summariseParam(rows, k, limitFor(plant, k), plant.kind).outside, k).toBe(flagged);
    }
  });

  it("breaks 'within limits' down by parameter, weakest first", () => {
    const { plant, entries } = buildSeed("2026-09-27");
    const rows = mergeSlots(entries, 3).rows;
    const b = limitBreakdown(plant, rows);
    expect([b.inside, b.judged]).toEqual([137, 141]);
    expect(b.params.map((p) => [p.key, p.inside, p.judged])).toEqual([
      ["tssOutlet", 12, 15], ["codOutlet", 14, 15], ["phOutlet", 87, 87], ["bodOutlet", 24, 24],
    ]);
    expect(limitBreakdownText(b)).toBe("TSS 12 of 15, COD 14 of 15, pH out 87 of 87, BOD 24 of 24");
    expect(b.rate).toBe(runChecks(plant, entries).complianceRate);
    // The same record against the 2019 limits: pH carries the pooled figure
    // while most of the lab results are outside.
    const strict = limitBreakdown({ ...plant, limits: LIMIT_PRESETS.find((p) => p.id === "ngt-2019")!.limits }, rows);
    expect([strict.inside, strict.judged]).toEqual([96, 141]);
    expect(strict.params.map((p) => [p.key, p.inside, p.judged])).toEqual([
      ["codOutlet", 2, 15], ["tssOutlet", 2, 15], ["bodOutlet", 5, 24], ["phOutlet", 87, 87],
    ]);
  });

  it("has no breakdown without limits, readings or a plant", () => {
    expect(limitBreakdown(null, null)).toEqual({ params: [], judged: 0, inside: 0, rate: null });
    expect(limitBreakdown(dailyPlant, dailyRegister("2026-09-01", 5)).rate).toBeNull();
    expect(limitBreakdown(shiftPlant, [E("2026-09-01", "A", { phOutlet: 71, codOutlet: NaN })]).rate).toBeNull();
    expect(limitBreakdown(shiftPlant, [null, 4, "x"] as unknown as LogEntry[]).rate).toBeNull();
    expect(limitBreakdownText(limitBreakdown(null, null))).toBe("");
  });
});

// ------------------------------------------------------ average daily volume

describe("averageDailyVolume", () => {
  const SH: ShiftCode[] = ["A", "B", "C"];
  // A totaliser that gains `step` at every entry, `perDay` entries a day.
  const meterRows = (perDay: 1 | 2 | 3, days: number, step: number) =>
    Array.from({ length: days * perDay }, (_, i) =>
      E(addDays("2026-09-01", Math.floor(i / perDay)), perDay === 1 ? null : SH[i % perDay], { outletTotaliser: 1000 + step * i }),
    );

  it("gives the same daily figure whether the meter is read once, twice or three times a day", () => {
    const one = averageDailyVolume(meterRows(1, 10, 60), "outletTotaliser", 1)!;
    expect(one).toEqual({ perDay: 60, days: 9, total: 540 });
    // Two shifts of 60 m³ are 120 m³ a day, not 60.
    const two = averageDailyVolume(meterRows(2, 10, 60), "outletTotaliser", 2)!;
    expect(two.total).toBe(1140);
    expect(two.days).toBe(9.5);
    expect(two.perDay).toBeCloseTo(120, 9);
    const three = averageDailyVolume(meterRows(3, 10, 60), "outletTotaliser", 3)!;
    expect(three.total).toBe(1740);
    expect(three.perDay).toBeCloseTo(180, 9);
  });

  it("agrees with the monthly report on the same rows", () => {
    const rows = meterRows(2, 10, 60);
    const r = buildReport({ ...shiftPlant, shiftsPerDay: 2, limits: {} }, rows, "2026-09");
    expect(r.outflow).toEqual({ value: 1140, source: "meter" });
    expect(r.daily[1].cells.outVolume).toBe(120);
  });

  it("adds neither volume nor time for a step where the meter fell", () => {
    const rows = meterRows(1, 10, 50);
    for (let i = 5; i < 10; i++) rows[i].values.outletTotaliser = 50 * (i - 5); // meter replaced on day 6
    expect(averageDailyVolume(rows, "outletTotaliser", 1)).toEqual({ perDay: 50, days: 8, total: 400 });
  });

  it("spreads an increase across a gap of several days over those days", () => {
    const rows = meterRows(1, 10, 60).filter((_, i) => i < 3 || i > 5);
    expect(averageDailyVolume(rows, "outletTotaliser", 1)).toEqual({ perDay: 60, days: 9, total: 540 });
  });

  it("is null when the readings cover less than a day, or there is nothing to count", () => {
    expect(averageDailyVolume(meterRows(3, 1, 60), "outletTotaliser", 3)).toBeNull(); // two thirds of a day
    expect(averageDailyVolume([], "outletTotaliser", 1)).toBeNull();
    expect(averageDailyVolume(null, "outletTotaliser", 1)).toBeNull();
    expect(averageDailyVolume(meterRows(1, 1, 60), "outletTotaliser", 1)).toBeNull();
    expect(averageDailyVolume([E("", null, { outletTotaliser: 1 }), E("", null, { outletTotaliser: 90 })], "outletTotaliser", 1)).toBeNull();
    expect(averageDailyVolume(meterRows(1, 10, 60), "inletTotaliser", 1)).toBeNull();
  });

  it("shows the daily sample plant's average to one decimal's worth of truth", () => {
    const { entries } = buildDailySeed("2026-09-20");
    const rows = mergeSlots(entries, 1).rows;
    const out = averageDailyVolume(rows, "outletTotaliser", 1)!;
    expect([out.total, out.days]).toEqual([337, 45]);
    expect(out.perDay).toBeCloseTo(7.49, 2); // shown as 7.5, not 7
    expect(averageDailyVolume(rows, "inletTotaliser", 1)!.perDay).toBeCloseTo(7.93, 2);
  });
});

// ----------------------------------------------------------- the month's edges

describe("a month's report at the edges of the month", () => {
  const reading = (date: string, v: number) => E(date, null, { inletTotaliser: v });
  // 1 to 25 Sep, then nothing until 1 to 5 Oct. 40 m³ a day throughout.
  const gapLog = () => [
    ...Array.from({ length: 25 }, (_, i) => reading(addDays("2026-09-01", i), 1000 + 40 * i)),
    ...Array.from({ length: 5 }, (_, i) => reading(addDays("2026-10-01", i), 1000 + 40 * (30 + i))),
  ];

  it("counts the days missing at the end of a month when the record goes on afterwards", () => {
    const entries = gapLog();
    const sep = buildReport(dailyPlant, entries, "2026-09");
    expect([sep.recorded, sep.expected]).toEqual([25, 30]);
    expect(sep.daily).toHaveLength(30);
    expect(sep.daily.slice(25).map((d) => [d.entries, d.recorded, d.expected])).toEqual(Array(5).fill([0, 0, 1]));
    expect([sep.firstDate, sep.lastDate]).toEqual(["2026-09-01", "2026-09-25"]);
    const oct = buildReport(dailyPlant, entries, "2026-10");
    expect([oct.recorded, oct.expected]).toEqual([5, 5]);
    // The two months together are the count on the overview and the Flags screen.
    const checks = runChecks(dailyPlant, entries);
    expect([sep.recorded + oct.recorded, sep.expected + oct.expected]).toEqual([checks.recordedShifts, checks.expectedShifts]);
    // Without anything after it, the same September ends at its last entry.
    const alone = buildReport(dailyPlant, entries.slice(0, 25), "2026-09");
    expect([alone.recorded, alone.expected]).toEqual([25, 25]);
  });

  it("says which meter increase is in neither month's total", () => {
    const entries = gapLog();
    const sep = buildReport(dailyPlant, entries, "2026-09");
    const oct = buildReport(dailyPlant, entries, "2026-10");
    expect(sep.inflow?.value).toBe(24 * 40);
    expect(oct.inflow?.value).toBe(4 * 40);
    const inlet = sep.meters.find((m) => m.key === "inletTotaliser")!;
    expect(inlet.unplaced).toEqual({ from: "2026-09-25", to: "2026-10-01", amount: 240 });
    const notes = reportNotes(sep).join(" ");
    expect(notes).toContain("rose by 240 m³ between the reading of 25 Sep and the next one, on 1 Oct");
    expect(notes).toContain("Nothing is counted after the reading of 25 Sep");
    expect(reportNotes(oct).join(" ")).toContain("No usable reading was taken in the 3 days before the month");
    expect(oct.meters[0].unplaced).toBeNull();
  });

  it("leaves nothing unplaced when the next month takes the increase", () => {
    // 1 to 29 Sep, then 1 Oct onwards: the reading of 29 Sep is within three days of October.
    const entries = gapLog().filter((e) => e.date <= "2026-09-25");
    for (let i = 25; i < 29; i++) entries.push(reading(addDays("2026-09-01", i), 1000 + 40 * i));
    for (let i = 30; i < 33; i++) entries.push(reading(addDays("2026-09-01", i), 1000 + 40 * i));
    const sep = buildReport(dailyPlant, entries, "2026-09");
    const oct = buildReport(dailyPlant, entries, "2026-10");
    expect(sep.meters[0].unplaced).toBeNull();
    expect([sep.recorded, sep.expected]).toEqual([29, 30]);
    expect(oct.meters[0].carriedIn).toBe(true);
    expect((sep.inflow?.value ?? 0) + (oct.inflow?.value ?? 0)).toBe(40 * 32); // nothing lost between the two
  });

  it("lists in a month the flags of the whole log that touch it", () => {
    const entries = gapLog();
    const checks = runChecks(dailyPlant, entries);
    const sep = flagsForMonth(checks.flags, entries, "2026-09");
    const oct = flagsForMonth(checks.flags, entries, "2026-10");
    // The five missing days begin on 26 Sep: September's report has them.
    expect(sep.some((f) => f.ruleId === "missing" && f.date === "2026-09-26")).toBe(true);
    expect(oct.some((f) => f.ruleId === "missing")).toBe(false);
    for (const f of [...sep, ...oct]) expect(checks.flags).toContain(f);
  });

  it("shows a meter that fell between the 31st and the 1st in the month it fell in", () => {
    const entries = [
      ...[9240, 9250, 9260, 9270].map((v, i) => E(addDays("2026-08-28", i), null, { energyKwh: v })),
      ...[4000, 4010, 4020, 4030].map((v, i) => E(addDays("2026-09-01", i), null, { energyKwh: v })),
    ];
    const checks = runChecks(dailyPlant, entries);
    const fell = checks.flags.filter((f) => f.ruleId === "meter");
    expect(fell.length).toBeGreaterThan(0);
    // Run on September alone the rule sees a meter that only rises.
    expect(runChecks(dailyPlant, entries.slice(4)).flags.filter((f) => f.ruleId === "meter")).toEqual([]);
    expect(flagsForMonth(checks.flags, entries, "2026-09").filter((f) => f.ruleId === "meter")).toEqual(fell);
    // And the report's own note about the fall is in the same month.
    expect(reportNotes(buildReport(dailyPlant, entries, "2026-09")).join(" ")).toMatch(/went down once/);
  });

  it("returns no flags for no flags, no entries or a month that is not one", () => {
    const flag = { id: "x", ruleId: "limit", date: "2026-09-03", entryIds: [] } as unknown as Flag;
    expect(flagsForMonth(null, [], "2026-09")).toEqual([]);
    expect(flagsForMonth([flag], null, "2026-09")).toEqual([flag]);
    expect(flagsForMonth([flag], null, "2026-10")).toEqual([]);
    expect(flagsForMonth([flag], null, "")).toEqual([]);
    expect(flagsForMonth([null, { id: "y" }, flag] as unknown as Flag[], [], "2026-09")).toEqual([flag]);
  });

  it("does not expect the shifts before a record's first entry, and marks that day's totals as partial", () => {
    const SH: ShiftCode[] = ["A", "B", "C"];
    const entries = [E("2026-09-01", "C", { inletFlow: 80 }), ...SH.map((s) => E("2026-09-02", s, { inletFlow: 80 }))];
    const r = buildReport(shiftPlant, entries, "2026-09");
    expect([r.recorded, r.expected]).toEqual([4, 4]);
    expect(r.daily[0]).toMatchObject({ recorded: 1, expected: 1, partial: ["inflow"] });
    expect(r.daily[1]).toMatchObject({ recorded: 3, expected: 3, partial: [] });
    expect(reportNotes(r).join(" ")).not.toContain("expected entr"); // nothing is missing
  });

  it("says the summed volumes are low when shift entries are missing, and marks the days", () => {
    const SH: ShiftCode[] = ["A", "B", "C"];
    const entries = Array.from({ length: 9 }, (_, i) => E(addDays("2026-09-01", Math.floor(i / 3)), SH[i % 3], { inletFlow: 80, outletFlow: 75, phOutlet: 7 }));
    const r = buildReport(shiftPlant, entries.filter((_, i) => i !== 4), "2026-09");
    expect([r.recorded, r.expected]).toEqual([8, 9]);
    expect(r.inflow).toEqual({ value: 640, source: "entries" });
    expect(r.daily[1].partial).toEqual(["inflow", "outflow"]);
    expect(r.daily[0].partial).toEqual([]);
    expect(reportNotes(r).join(" ")).toContain("sum of the 8 shift entries on record. 1 expected entry is missing, so the totals leave out whatever passed in those shifts.");
    // A total taken from a meter is not a sum of entries: no such note.
    const daily = buildReport(dailyPlant, dailyRegister("2026-09-01", 5).filter((_, i) => i !== 2), "2026-09");
    expect(reportNotes(daily).join(" ")).not.toContain("on record");
  });

  it("still shows an entry dated far from the rest in its own month", () => {
    const entries = [E("2006-09-01", null, { limeKg: 1 }), ...dailyRegister("2026-09-01", 6)];
    const r = buildReport(dailyPlant, entries, "2006-09");
    expect(r.rows).toHaveLength(1);
    expect(r.daily).toHaveLength(1);
    expect([r.recorded, r.expected]).toEqual([1, 1]);
    const now = buildReport(dailyPlant, entries, "2026-09");
    expect([now.recorded, now.expected]).toEqual([6, 6]);
  });
});

// ------------------------------------------------------ which month to open

describe("monthStats and defaultMonth", () => {
  it("opens on the latest month with a week of entries, not on a month two days old", () => {
    const { plant, entries } = buildSeed("2026-09-27");
    const more = [...entries, E("2026-10-01", "A"), E("2026-10-01", "B"), E("2026-10-01", "C")];
    const stats = monthStats(more, entriesPerDay(plant));
    expect(stats).toEqual([
      { month: "2026-10", entries: 3, days: 1 },
      { month: "2026-09", entries: 79, days: 27 },
      { month: "2026-08", entries: 9, days: 3 },
    ]);
    expect(defaultMonth(stats)).toBe("2026-09");
    const oct = buildReport(plant, more, "2026-10");
    expect([oct.daysRecorded, oct.daysInMonth]).toEqual([1, 31]);
    expect(oct.daysRecorded).toBeLessThan(PARTIAL_MONTH_DAYS);
  });

  it("falls back to the latest month when none has a week of entries", () => {
    const stats = monthStats([E("2026-10-01", null), E("2026-10-02", null), E("2026-09-30", null)], 1);
    expect(defaultMonth(stats)).toBe("2026-10");
    expect(defaultMonth([])).toBeNull();
    expect(defaultMonth(null)).toBeNull();
    expect(monthStats(null, 3)).toEqual([]);
    expect(monthStats([E("", "A"), E("31/12/2026", "A")], 3)).toEqual([]);
  });

  it("counts a date and shift saved twice once", () => {
    const a = E("2026-09-01", "A", { phOutlet: 7 });
    expect(monthStats([a, { ...a, id: "again" }], 3)).toEqual([{ month: "2026-09", entries: 1, days: 1 }]);
  });

  it("knows the length of a month, and of something that is not one", () => {
    expect(buildReport(dailyPlant, [], "2028-02").daysInMonth).toBe(29);
    expect(buildReport(dailyPlant, [], "2026-02").daysInMonth).toBe(28);
    expect(buildReport(dailyPlant, [], "2026-13").daysInMonth).toBe(0);
    expect(buildReport(dailyPlant, [], "nope").daysInMonth).toBe(0);
  });
});

// ------------------------------------------------------------ trend series

describe("trendSeries", () => {
  it("is empty for an empty or missing log", () => {
    expect(trendSeries([], "tssOutlet")).toEqual({
      mode: "reading", points: [], skipped: 0, aboveCap: [], falls: 0, outOfSequence: 0, spans: 0, per: "day",
    });
    expect(trendSeries(null, "energyKwh").points).toEqual([]);
  });

  it("plots readings at their position in the log and skips impossible ones", () => {
    const rows = [E("2026-09-01", "A", { phOutlet: 7 }), E("2026-09-01", "B", {}), E("2026-09-01", "C", { phOutlet: 71 }), E("2026-09-02", "A", { phOutlet: 0 })];
    const s = trendSeries(rows, "phOutlet");
    expect(s.mode).toBe("reading");
    expect(s.points.map((p) => [p.i, p.v])).toEqual([[0, 7], [3, 0]]);
    expect(s.skipped).toBe(1);
  });

  it("plots a cumulative meter as increases, never as the rising readings", () => {
    const rows = [100, 103, 106, 50, 53].map((v, i) => E(addDays("2026-09-01", i), null, { energyKwh: v }));
    const s = trendSeries(rows, "energyKwh");
    expect(s.mode).toBe("increase");
    expect(s.points.map((p) => [p.i, p.v])).toEqual([[1, 3], [2, 3], [4, 3]]);
    expect(s.falls).toBe(1);
    for (const p of s.points) expect(p.v).toBeGreaterThanOrEqual(0);
  });

  it("gives a daily register its daily volume from the totaliser", () => {
    const s = trendSeries(sortLog(dailyRegister("2026-09-01", 6)), "outletTotaliser");
    expect(s.points.map((p) => p.v)).toEqual([38, 38, 38, 38, 38]);
    expect(s.points[0].days).toBe(1);
    expect(s.per).toBe("day");
    expect(s.spans).toBe(0);
  });

  it("plots an increase across missing days as a daily average, not as one day's spike", () => {
    const rows = sortLog(dailyRegister("2026-09-01", 12).filter((_, i) => i < 3 || i > 7)); // 4 to 8 Sep missing
    const s = trendSeries(rows, "inletTotaliser", { perDay: 1 });
    expect(s.spans).toBe(1);
    const span = s.points.find((p) => p.span > 1)!;
    expect(span).toMatchObject({ v: 40, total: 240, span: 6, days: 6 });
    expect(span.entry.date).toBe("2026-09-09");
    expect(span.since?.date).toBe("2026-09-03");
    expect(Math.max(...s.points.map((p) => p.v))).toBe(40); // no spike
  });

  it("averages an increase across a missing shift over the shifts it covers", () => {
    const SH: ShiftCode[] = ["A", "B", "C"];
    const rows = Array.from({ length: 12 }, (_, i) => E(addDays("2026-09-01", Math.floor(i / 3)), SH[i % 3], { energyKwh: 1000 + 80 * i }));
    const s = trendSeries(rows.filter((_, i) => i !== 5), "energyKwh", { perDay: 3 });
    expect(s.per).toBe("shift");
    expect(s.spans).toBe(1);
    expect(s.points.find((p) => p.span > 1)).toMatchObject({ v: 80, total: 160, span: 2 });
    expect(s.points.every((p) => p.v === 80)).toBe(true);
  });

  it("does not call a meter read once a day at a shift plant a gap", () => {
    const SH: ShiftCode[] = ["A", "B", "C"];
    const rows = Array.from({ length: 15 }, (_, i) =>
      E(addDays("2026-09-01", Math.floor(i / 3)), SH[i % 3], i % 3 === 2 ? { energyKwh: 1000 + 240 * Math.floor(i / 3) } : { phOutlet: 7 }),
    );
    const s = trendSeries(rows, "energyKwh", { perDay: 3 });
    expect(s.per).toBe("day");
    expect(s.spans).toBe(0);
    expect(s.points.map((p) => p.v)).toEqual([240, 240, 240, 240]);
  });

  it("keeps a meter read at its own rhythm as increases since the last reading", () => {
    const weeks = [0, 7, 14, 28, 35].map((d, i) => E(addDays("2026-08-01", d), null, { energyKwh: 1000 + 70 * [0, 1, 2, 4, 5][i] }));
    const s = trendSeries(weeks, "energyKwh", { perDay: 1 });
    expect(s.per).toBe("reading");
    expect(s.points.map((p) => [p.total, p.span, p.v])).toEqual([[70, 1, 70], [70, 1, 70], [140, 2, 70], [70, 1, 70]]);
  });

  it("plots undated rows as they stand, since their spacing is unknown", () => {
    const s = trendSeries([E("", null, { energyKwh: 10 }), E("", null, { energyKwh: 25 })], "energyKwh", { perDay: 1 });
    expect(s.points.map((p) => [p.v, p.span, p.days])).toEqual([[15, 1, null]]);
  });

  it("shows no spike on the bundled sample plants", () => {
    // Daily register: an increase across missing or set-aside readings used to
    // plot as up to 48 m³ in "one day" at a 10 KLD plant.
    const daily = buildDailySeed("2026-09-20");
    const dailyRows = mergeSlots(daily.entries, 1).rows;
    for (const k of ["inletTotaliser", "outletTotaliser"] as ParamKey[]) {
      const s = trendSeries(dailyRows, k, { kind: daily.plant.kind, perDay: 1 });
      expect(s.per).toBe("day");
      expect(s.spans, k).toBeGreaterThan(0);
      for (const p of s.points) expect(p.v, `${k} ${p.entry.date}`).toBeLessThanOrEqual(daily.plant.capacityKld);
    }
    // 3-shift plant: three energy increases cover two shifts each (a missing
    // entry, the planted misread). A normal shift is about 80 kWh.
    const shift = buildSeed("2026-09-27");
    const s = trendSeries(mergeSlots(shift.entries, 3).rows, "energyKwh", { kind: shift.plant.kind, perDay: 3 });
    expect(s.per).toBe("shift");
    expect(s.points.filter((p) => p.span > 1).map((p) => [p.entry.date, p.entry.shift, p.total, p.span, p.v])).toEqual([
      ["2026-09-03", "C", 165, 2, 82.5],
      ["2026-09-16", "C", 165, 2, 82.5],
      ["2026-09-24", "B", 177, 2, 88.5],
    ]);
    expect(Math.max(...s.points.map((p) => p.v))).toBeLessThan(110);
  });
});

// -------------------------------------------------------------- chart maths

describe("niceTicks", () => {
  const ok = (t: number[]) => {
    expect(t.length, JSON.stringify(t)).toBeGreaterThanOrEqual(2);
    expect(t.length, JSON.stringify(t)).toBeLessThanOrEqual(14);
    for (let i = 0; i < t.length; i++) {
      expect(Number.isFinite(t[i]), JSON.stringify(t)).toBe(true);
      if (i) expect(t[i], JSON.stringify(t)).toBeGreaterThan(t[i - 1]);
    }
  };

  it("covers the range with round, increasing values", () => {
    const t = niceTicks(3, 97);
    ok(t);
    expect(t[0]).toBeLessThanOrEqual(3);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(97);
    expect(niceTicks(0, 100)).toEqual([0, 25, 50, 75, 100]);
  });

  it("survives a single value, all-equal values and zeros", () => {
    ok(niceTicks(5, 5));
    ok(niceTicks(0, 0));
    ok(niceTicks(0, 0, 4, 1));
    expect(niceTicks(0, 0, 4, 1)).toEqual([0, 1]);
    ok(niceTicks(7.2, 7.2, 4, 0.1));
  });

  it("survives very large, tiny, reversed and non-finite ranges", () => {
    ok(niceTicks(0, 1e9));
    ok(niceTicks(999999990, 1e9));
    ok(niceTicks(1e15, 1e15));
    ok(niceTicks(1e15, 1e15 + 2));
    ok(niceTicks(0, 1e-9));
    ok(niceTicks(100, 0));
    ok(niceTicks(-50, 50));
    ok(niceTicks(NaN, 5));
    ok(niceTicks(0, Infinity));
    ok(niceTicks(0, 10, 0));
    ok(niceTicks(0, 10, NaN, NaN));
  });

  it("does not go below the smallest step a whole-number quantity can show", () => {
    const t = niceTicks(40, 42, 4, 1);
    for (const v of t) expect(Number.isInteger(v), JSON.stringify(t)).toBe(true);
  });
});

describe("thinForDrawing", () => {
  it("keeps everything when points are sparse", () => {
    expect(thinForDrawing([0, 10, 20], [1, 2, 3])).toEqual([0, 1, 2]);
    expect(thinForDrawing([], [])).toEqual([]);
    expect(thinForDrawing([5], [9])).toEqual([0]);
  });

  it("cuts 5,000 points down to a few per pixel and keeps every extreme", () => {
    const n = 5000;
    const width = 300;
    const xs = Array.from({ length: n }, (_, i) => (i / (n - 1)) * width);
    const ys = Array.from({ length: n }, (_, i) => Math.sin(i / 40) * 50 + (i === 1234 ? 900 : 0) + (i === 4321 ? -900 : 0));
    const keep = thinForDrawing(xs, ys);
    expect(keep.length).toBeLessThanOrEqual(4 * (width + 1));
    expect(keep.length).toBeLessThan(n / 3);
    expect(keep[0]).toBe(0);
    expect(keep[keep.length - 1]).toBe(n - 1);
    expect(keep).toContain(1234);
    expect(keep).toContain(4321);
    for (let i = 1; i < keep.length; i++) expect(keep[i]).toBeGreaterThan(keep[i - 1]);
  });

  it("copes with all-equal values", () => {
    const keep = thinForDrawing(Array.from({ length: 1000 }, (_, i) => i / 100), Array(1000).fill(7));
    expect(keep.length).toBeLessThanOrEqual(20);
    expect(keep[0]).toBe(0);
    expect(keep[keep.length - 1]).toBe(999);
  });
});

describe("nearestIndex", () => {
  it("finds the closest position, exactly, in a long list", () => {
    const xs = Array.from({ length: 2000 }, (_, i) => i * 0.25);
    expect(nearestIndex(xs, 100.1)).toBe(400);
    expect(nearestIndex(xs, 100.13)).toBe(401);
    expect(nearestIndex(xs, -50)).toBe(0);
    expect(nearestIndex(xs, 1e9)).toBe(1999);
  });

  it("handles empty, single and non-finite input", () => {
    expect(nearestIndex([], 5)).toBe(-1);
    expect(nearestIndex([3], 500)).toBe(0);
    expect(nearestIndex([1, 2, 3], NaN)).toBe(0);
  });
});

// ------------------------------------------- values the checks call out of scale

describe("figures the checks flagged as out of scale", () => {
  // 20 days at a 50 KLD plant: about 40 m³ a day on the meters, 0.5 kg of lime.
  const month = "2026-09";
  const register = () => dailyRegister("2026-09-01", 20);
  const reportOf = (plant: Plant, entries: LogEntry[]) => {
    const flags = runChecks(plant, entries).flags;
    return { flags, r: buildReport(plant, entries, month, { strayIds: strayIdsFrom(flags), suspect: suspectValuesFrom(flags) }) };
  };

  it("reads only the three kinds of flag, and survives junk", () => {
    const flags = [
      { id: "physical:scale:limeKg:above", ruleId: "physical", param: "limeKg", entryIds: ["a", "b", 7] },
      { id: "physical:capacity:inletFlow", ruleId: "physical", param: "inletFlow", entryIds: ["c"] },
      { id: "physical:jump:energyKwh", ruleId: "physical", param: "energyKwh", entryIds: ["d"] },
      { id: "physical:phOutlet:x", ruleId: "physical", param: "phOutlet", entryIds: ["e"] },
      { id: "physical:scale:nope", ruleId: "physical", param: "nope", entryIds: ["f"] },
      { id: "physical:scale:limeKg:below", ruleId: "physical", param: "limeKg" },
      null,
    ] as unknown as Flag[];
    const m = suspectValuesFrom(flags);
    expect([...m.keys()].sort()).toEqual(["energyKwh", "inletFlow", "limeKg"]);
    expect([...(m.get("limeKg") ?? [])]).toEqual(["a", "b"]);
    expect(suspectValuesFrom(null).size).toBe(0);
    expect(suspectValuesFrom("x" as unknown as Flag[]).size).toBe(0);
  });

  it("a dose written in grams in the kilogram column stays in the daily record but not in the total, average or maximum", () => {
    const entries = register();
    entries[9].values.limeKg = 500; // "500" for 500 g
    const { flags, r } = reportOf(dailyPlant, entries);
    expect(flags.some((f) => f.id.startsWith("physical:") && f.param === "limeKg"), JSON.stringify(flags.map((f) => f.id))).toBe(true);
    const lime = r.summaries.find((x) => x.key === "limeKg")!;
    expect(lime.setAside).toBe(1);
    expect(lime.n).toBe(19);
    expect(lime.max).toBe(0.5);
    expect(lime.total).toBe(9.5);
    expect(r.totals.lime).toBe(9.5);
    const day = r.daily.find((d) => d.date === entries[9].date)!;
    expect(day.cells.lime).toBe(500);
    expect(day.setAside).toContain("lime");
    expect(r.setAside).toBe(1);
    expect(reportNotes(r).some((n) => n.startsWith("1 value (lime dosed) is far out of scale")), reportNotes(r).join(" | ")).toBe(true);
    // Without the flags the old arithmetic still holds: nothing is hidden silently.
    const plain = buildReport(dailyPlant, entries, month);
    expect(plain.summaries.find((x) => x.key === "limeKg")!.total).toBe(509.5);
    expect(plain.setAside).toBe(0);
  });

  it("a meter reading with an extra digit on the last row of the log is not counted as volume", () => {
    const entries = register();
    const last = entries[entries.length - 1];
    last.values.inletTotaliser = (last.values.inletTotaliser as number) * 10; // 1760 -> 17600
    const { flags, r } = reportOf(dailyPlant, entries);
    expect(flags.some((f) => /^physical:(jump|capacity):inletTotaliser$/.test(f.id)), JSON.stringify(flags.map((f) => f.id))).toBe(true);
    const meter = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(meter.jumps).toBe(1);
    expect(meter.total).toBe(40 * 18);
    expect(r.inflow).toEqual({ value: 720, source: "meter" });
    expect(reportNotes(r).some((n) => /rose by far more than it usually does once/.test(n)), reportNotes(r).join(" | ")).toBe(true);
    const day = r.daily.find((d) => d.date === last.date)!;
    expect(day.cells.inMeter).toBe(last.values.inletTotaliser);
    expect(day.setAside).toContain("inMeter");
    expect(day.cells.inVolume).toBeNull();
    // The overview tile follows the same rule.
    const suspect = suspectValuesFrom(flags);
    const withRule = averageDailyVolume(sortLog(entries), "inletTotaliser", 1, suspect)!;
    expect(withRule.perDay).toBeCloseTo(40, 6);
    expect(averageDailyVolume(sortLog(entries), "inletTotaliser", 1)!.perDay).toBeGreaterThan(800);
  });

  it("a slipped digit in the middle of the log is still left out by the sequence rule, with the increase counted across it", () => {
    const entries = register();
    entries[10].values.inletTotaliser = 14000; // 1400 with an extra 0; the next row is 1440 again
    const { r } = reportOf(dailyPlant, entries);
    const meter = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(meter.outOfSequence).toBe(1);
    expect(meter.jumps).toBe(0);
    expect(meter.total).toBe(40 * 19);
  });

  it("a meter that stays high after the jump restarts the count there", () => {
    const entries = register();
    for (let i = 12; i < 20; i++) entries[i].values.inletTotaliser = (entries[i].values.inletTotaliser as number) + 50000;
    const { flags, r } = reportOf(dailyPlant, entries);
    expect(flags.some((f) => /^physical:(jump|capacity):inletTotaliser$/.test(f.id)), JSON.stringify(flags.map((f) => f.id))).toBe(true);
    const meter = r.meters.find((m) => m.key === "inletTotaliser")!;
    expect(meter.jumps).toBe(1);
    expect(meter.total).toBe(40 * 18); // 11 steps before the jump, 7 after it
  });

  it("meterSteps ignores a suspect entry whose reading does not rise", () => {
    const rows = [E("2026-09-01", null, { energyKwh: 100 }), E("2026-09-02", null, { energyKwh: 100 }), E("2026-09-03", null, { energyKwh: 130 })];
    const steps = meterSteps(rows, "energyKwh", new Set([rows[1].id]));
    expect(steps.map((x) => x.status)).toEqual(["first", "counted", "counted"]);
    expect(meterSteps(rows, "energyKwh", new Set()).map((x) => x.increase)).toEqual([null, 0, 30]);
  });

  it("a shift flow far above the plant's capacity is left out of the month's inlet volume", () => {
    const entries: LogEntry[] = [];
    for (let d = 0; d < 10; d++) for (const sh of ["A", "B", "C"] as ShiftCode[]) entries.push(E(addDays("2026-09-01", d), sh, { inletFlow: 80, outletFlow: 76 }));
    entries[13].values.inletFlow = 8000;
    const { flags, r } = reportOf(shiftPlant, entries);
    expect(flags.some((f) => f.id.startsWith("physical:") && f.param === "inletFlow"), JSON.stringify(flags.map((f) => f.id))).toBe(true);
    const flow = r.summaries.find((x) => x.key === "inletFlow")!;
    expect(flow.setAside).toBeGreaterThanOrEqual(1);
    expect(flow.max).toBe(80);
    expect(r.inflow?.value).toBe(flow.total);
    expect(r.totals.inflow).toBe(flow.total);
    expect(flow.total).toBeLessThan(80 * 30);
  });
});
