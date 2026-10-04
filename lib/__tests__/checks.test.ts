import { describe, expect, it } from "vitest";
import { RULES, STEP_MIN_N, TWIN_MIN_N, runChecks } from "../checks";
import { DEFAULT_LIMITS } from "../params";
import type { Flag, LogEntry, ParamKey, Plant, ShiftCode } from "../types";

const plant: Plant = {
  id: "p1",
  name: "Test STP",
  kind: "STP",
  location: "Jaipur",
  capacityKld: 250,
  technology: "SBR",
  operatorCompany: "Test O&M",
  consentNo: "TEST",
  shiftsPerDay: 3,
  limits: DEFAULT_LIMITS.STP,
};
// One row a day, no shift letter, no time: the meter-and-dosing register.
const dailyPlant: Plant = { ...plant, id: "p2", capacityKld: 10, shiftsPerDay: 1 };

const SH: ShiftCode[] = ["A", "B", "C"];

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

let counter = 0;
function E(
  date: string,
  shift: ShiftCode | null,
  values: LogEntry["values"] = {},
  extra: Partial<LogEntry> = {},
): LogEntry {
  counter++;
  return {
    id: `e${counter}`,
    plantId: "p1",
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

// i-th shift slot counting from 1 Sep 2026, three shifts a day.
function slot(i: number): { date: string; shift: ShiftCode } {
  return { date: addDays("2026-09-01", Math.floor(i / 3)), shift: SH[i % 3] };
}

function series(
  n: number,
  fn: (i: number) => LogEntry["values"],
  extra: (i: number) => Partial<LogEntry> = () => ({}),
): LogEntry[] {
  return Array.from({ length: n }, (_, i) => {
    const s = slot(i);
    return E(s.date, s.shift, fn(i), extra(i));
  });
}

// n daily rows from 1 Sep 2026: shift null, time null.
function daily(
  n: number,
  fn: (i: number) => LogEntry["values"],
  extra: (i: number) => Partial<LogEntry> = () => ({}),
): LogEntry[] {
  return Array.from({ length: n }, (_, i) => E(addDays("2026-09-01", i), null, fn(i), extra(i)));
}

function of(es: LogEntry[], ruleId: string, p: Plant = plant): Flag[] {
  return runChecks(p, es).flags.filter((f) => f.ruleId === ruleId);
}

const text = (f: Flag) => `${f.title} ${f.detail} ${f.verify}`;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Last digit is 0/5 only about 20% of the time, no consecutive repeats.
const spread = (i: number) => 7 + ((i * 3) % 10) / 10 + (i % 4) * 0.01;
// 61 different whole numbers before it comes round again.
const distinct = (i: number) => 60 + ((i * 37) % 61);

describe("limit", () => {
  it("flags a run of exceedances as one flag and treats the limit as inclusive", () => {
    const es = series(5, (i) => ({ tssOutlet: [100, 120, 135, 100, 90][i] }));
    const f = of(es, "limit");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].param).toBe("tssOutlet");
    expect(f[0].entryIds).toEqual([es[1].id, es[2].id]);
    expect(f[0].detail).toContain("135");
  });
  it("makes one flag per separate run and checks a minimum limit", () => {
    const es = series(5, (i) => ({ tssOutlet: [120, 50, 130, 50, 50][i], phOutlet: [7, 7, 7, 7, 6.0][i] }));
    expect(of(es, "limit").filter((f) => f.param === "tssOutlet")).toHaveLength(2);
    expect(of(es, "limit").filter((f) => f.param === "phOutlet")).toHaveLength(1);
  });
  it("does not flag values inside limits", () => {
    expect(of(series(4, () => ({ tssOutlet: 99, codOutlet: 250, phOutlet: 6.5 })), "limit")).toHaveLength(0);
  });
  it("leaves physically impossible values to the physical rule", () => {
    const es = series(2, (i) => ({ phOutlet: i ? 71 : 7 }));
    expect(of(es, "limit")).toHaveLength(0);
    expect(of(es, "physical")).toHaveLength(1);
  });
  it("does not call readings weeks apart consecutive", () => {
    const es = [E("2026-09-01", "A", { tssOutlet: 130 }), E("2026-09-10", "A", {}), E("2026-09-20", "A", { tssOutlet: 140 })];
    const f = of(es, "limit");
    expect(f).toHaveLength(2);
    for (const x of f) expect(x.entryIds).toHaveLength(1);
    // two days apart with a blank between still counts as one run
    const near = [E("2026-09-01", "A", { tssOutlet: 130 }), E("2026-09-02", "A", {}), E("2026-09-03", "A", { tssOutlet: 140 })];
    expect(of(near, "limit")).toHaveLength(1);
  });
  it("copes with limits left half-empty by a cleared form field", () => {
    const es = series(4, () => ({ phOutlet: 7.2, tssOutlet: 500 }));
    const cleared = { ...plant, limits: { phOutlet: { min: 6.5, max: null }, tssOutlet: { max: Number.NaN } } } as unknown as Plant;
    const r = runChecks(cleared, es);
    expect(r.flags.filter((f) => f.ruleId === "limit")).toHaveLength(0);
    expect(r.complianceRate).toBe(1); // only the pH minimum is a limit
    const low = runChecks(cleared, series(2, () => ({ phOutlet: 6.0 }))).flags.filter((f) => f.ruleId === "limit");
    expect(low).toHaveLength(1);
    expect(low[0].detail).toContain("min 6.5");
    expect(low[0].detail).not.toContain("-");
  });
  it("treats an empty limit as no limit at all", () => {
    const none = { ...plant, limits: { tssOutlet: {} } } as Plant;
    const r = runChecks(none, series(3, () => ({ tssOutlet: 900 })));
    expect(r.flags.filter((f) => f.ruleId === "limit")).toHaveLength(0);
    expect(r.complianceRate).toBeNull();
    expect(() => runChecks({ ...plant, limits: undefined } as unknown as Plant, series(3, () => ({ tssOutlet: 900 })))).not.toThrow();
  });
  it("reports a huge reading at an ETP as an exceedance, not a typo", () => {
    const etp: Plant = { ...plant, kind: "ETP", limits: DEFAULT_LIMITS.ETP };
    const es = series(2, (i) => ({ codOutlet: i ? 6000 : 180 }));
    const lim = of(es, "limit", etp);
    expect(lim).toHaveLength(1);
    expect(lim[0].detail).toContain("6000");
    expect(of(es, "physical", etp)).toHaveLength(0);
    expect(runChecks(etp, es).complianceRate).toBeCloseTo(0.5);
  });
  it("reports a reading above the sewage-plant cap as both a possible typo and an exceedance", () => {
    const es = series(2, (i) => ({ codOutlet: i ? 6000 : 180 }));
    const lim = of(es, "limit");
    expect(lim).toHaveLength(1);
    expect(lim[0].title).toContain("typo or very large exceedance");
    const phys = of(es, "physical");
    expect(phys).toHaveLength(1);
    expect(phys[0].detail).toContain("very large exceedance");
    expect(runChecks(plant, es).complianceRate).toBeCloseTo(0.5);
  });
  it("words the flag for the parameter it is about", () => {
    const inletLimit = { ...plant, limits: { phInlet: { min: 6, max: 9 }, codOutlet: { max: 250 } } } as Plant;
    const f = runChecks(inletLimit, series(2, (i) => ({ phInlet: i ? 10.2 : 7, codOutlet: i ? 300 : 100 }))).flags.filter((x) => x.ruleId === "limit");
    const inlet = f.find((x) => x.param === "phInlet")!;
    const cod = f.find((x) => x.param === "codOutlet")!;
    expect(inlet.verify).not.toContain("final outlet");
    expect(cod.verify).toContain("final outlet");
    expect(cod.verify).toContain("Outlet COD"); // label as written, not "outlet cod"
    expect(cod.verify).toContain("check what the consent order requires");
    expect(text(cod)).not.toMatch(/needs reporting/);
    expect(text(cod)).not.toMatch(/from 1 Sep, shift B to 1 Sep, shift B/);
  });
});

describe("physical", () => {
  it("flags pH 71 but not pH 14", () => {
    expect(of(series(1, () => ({ phOutlet: 71 })), "physical")[0].severity).toBe("high");
    expect(of(series(1, () => ({ phOutlet: 14 })), "physical")).toHaveLength(0);
  });
  it("quotes the value as written and the bounds without padding", () => {
    const es = [E("2026-09-01", "A", { phOutlet: 71 }, { cellMeta: { phOutlet: { raw: "7I", confidence: "low" } } })];
    const f = of(es, "physical")[0];
    expect(f.detail).toContain("recorded as 7I");
    expect(f.detail).toContain("0 to 14");
    expect(f.detail).not.toContain("14.0");
    // once a person has corrected the cell, the raw text no longer describes it
    const edited = [{ ...es[0], id: "ed", edited: ["phOutlet"] as ParamKey[] }];
    expect(of(edited, "physical")[0].detail).toContain("recorded as 71 ");
  });
  it("does not explain a negative value as a missing decimal point", () => {
    const f = of(series(1, () => ({ codOutlet: -40 })), "physical");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("cannot be negative");
    expect(f[0].detail).not.toContain("decimal point");
    expect(of(series(1, () => ({ codOutlet: -40 })), "limit")).toHaveLength(0);
  });
  it("flags BOD above COD but not equal", () => {
    expect(of(series(1, () => ({ bodOutlet: 60, codOutlet: 50 })), "physical")).toHaveLength(1);
    expect(of(series(1, () => ({ bodOutlet: 50, codOutlet: 50 })), "physical")).toHaveLength(0);
  });
  it("flags outlet flow more than 15% above inlet over a full day", () => {
    const bad = series(3, () => ({ inletFlow: 100, outletFlow: 120 }));
    const ok = series(3, () => ({ inletFlow: 100, outletFlow: 110 }));
    expect(of(bad, "physical")).toHaveLength(1);
    expect(of(bad, "physical")[0].entryIds).toHaveLength(3);
    expect(of(bad, "physical")[0].severity).toBe("medium");
    expect(of(ok, "physical")).toHaveLength(0);
  });
  it("does not compare flows on a day with shifts missing or one flow blank", () => {
    const blank = series(3, (i) => ({ inletFlow: 100, outletFlow: i === 0 ? null : 150 }));
    expect(of(blank, "physical")).toHaveLength(0);
    // a lone night shift draining the equalisation tank
    expect(of([E("2026-09-01", "C", { inletFlow: 50, outletFlow: 70 })], "physical")).toHaveLength(0);
    // at a one-entry-a-day plant the single row is the whole day
    expect(of(daily(1, () => ({ inletFlow: 5, outletFlow: 7 })), "physical", dailyPlant)).toHaveLength(1);
  });
  it("asks about blower hours longer than the shift without calling them impossible", () => {
    const f = of(series(1, () => ({ blowerHours: 9 })), "physical");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].verify).toContain("more than one blower");
    expect(of(series(1, () => ({ blowerHours: 8 })), "physical")).toHaveLength(0);
    const two: Plant = { ...plant, shiftsPerDay: 2 };
    expect(of(series(1, () => ({ blowerHours: 13 })), "physical", two)).toHaveLength(1);
    expect(of(series(1, () => ({ blowerHours: 12 })), "physical", two)).toHaveLength(0);
    expect(of(series(1, () => ({ blowerHours: 25 })), "physical")[0].severity).toBe("high");
  });
  it("flags run hours above 24 and accepts 24", () => {
    expect(of(daily(1, () => ({ runHours: 24 })), "physical", dailyPlant)).toHaveLength(0);
    const f = of(daily(1, () => ({ runHours: 26 })), "physical", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].param).toBe("runHours");
  });
});

describe("repeat", () => {
  it("flags a short run in a column whose readings never agree", () => {
    const es = series(45, (i) => ({ inletFlow: i >= 20 && i < 25 ? 77 : distinct(i) }));
    const f = of(es, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].param).toBe("inletFlow");
    expect(f[0].entryIds).toEqual(es.slice(20, 25).map((e) => e.id));
    // three in a row is never enough
    expect(of(series(45, (i) => ({ inletFlow: i >= 20 && i < 23 ? 77 : distinct(i) })), "repeat")).toHaveLength(0);
  });
  it("needs a much longer run in a column whose readings agree all the time", () => {
    const rnd = mulberry32(11);
    const coarse = Array.from({ length: 90 }, () => [7.2, 7.3, 7.3, 7.4][Math.floor(rnd() * 4)]);
    // six identical readings in a pH-like column: unremarkable
    const six = series(90, (i) => ({ phOutlet: i >= 30 && i < 36 ? 7.3 : coarse[i] }));
    expect(of(six, "repeat"), JSON.stringify(of(six, "repeat").map((f) => f.detail))).toHaveLength(0);
    // the same six identical readings in a flow column: flagged
    const sixFlow = series(90, (i) => ({ inletFlow: i >= 30 && i < 36 ? 77 : distinct(i) + i }));
    expect(of(sixFlow, "repeat")).toHaveLength(1);
    // twenty-five in a column where two readings in three are that value
    // anyway: still unremarkable. (7.3 is 43 of the other 65 readings here.)
    const some = series(90, (i) => ({ phOutlet: i >= 30 && i < 55 ? 7.3 : coarse[i] }));
    expect(of(some, "repeat")).toHaveLength(0);
    // thirty-five identical pH readings: flagged
    const long = series(90, (i) => ({ phOutlet: i >= 30 && i < 65 ? 7.3 : coarse[i] }));
    const f = of(long, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].entryIds.length).toBeGreaterThanOrEqual(35);
    expect(f[0].verify).toContain("can honestly give the same figure");
    expect(f[0].verify).not.toContain("normally move");
  });
  it("does not judge a constant column until there is enough of it", () => {
    expect(of(series(6, () => ({ phInlet: 7.2 })), "repeat")).toHaveLength(0);
    const f = of(series(30, () => ({ phInlet: 7.2 })), "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium"); // one parameter is never high
    expect(f[0].entryIds).toHaveLength(30);
  });
  it("is high only when two or more parameters repeat over the same entries", () => {
    const f = of(series(12, () => ({ phInlet: 7.2, doAeration: 2.1 })), "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].detail).toContain("Inlet pH");
    expect(f[0].detail).toContain("Aeration tank DO");
    expect(f[0].param).toBeUndefined();
  });
  it("still groups parameters when one run is a reading longer than the other", () => {
    const es = series(45, (i) => ({
      inletFlow: i >= 20 && i < 27 ? 77 : distinct(i),
      mlss: i >= 20 && i < 28 ? 3000 : 2500 + distinct(i) * 10,
    }));
    const f = of(es, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].entryIds).toEqual(es.slice(20, 28).map((e) => e.id));
    expect(f[0].detail).toContain("over 7 entries in a row");
  });
  it("bridges one blank cell but not two", () => {
    const one = series(45, (i) => ({ inletFlow: i === 23 ? null : i >= 20 && i < 27 ? 77 : distinct(i) }));
    const f = of(one, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].entryIds).toHaveLength(6);
    const two = series(45, (i) => ({ inletFlow: i === 23 || i === 24 ? null : i >= 20 && i < 28 ? 77 : distinct(i) }));
    expect(of(two, "repeat")).toHaveLength(0);
  });
  it("ignores a run broken by a change", () => {
    expect(of(series(45, (i) => ({ inletFlow: i === 23 ? 78 : i >= 20 && i < 27 ? 77 : distinct(i) })), "repeat")).toHaveLength(0);
  });
  it("does not apply to parameters that do not vary", () => {
    expect(of(series(40, () => ({ blowerHours: 7, runHours: 6, limeKg: 0.5 })), "repeat")).toHaveLength(0);
  });
  it("catches the same figures repeating night after night", () => {
    const es = series(60, (i) => ({ phInlet: i % 3 === 2 && i >= 15 && i < 39 ? 7.4 : spread(i) }));
    const f = of(es, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].entryIds).toHaveLength(8);
    expect(f[0].detail).toContain("shift C");
  });
});

describe("rowcopy", () => {
  const lab = (i: number) => ({
    phInlet: 6.8 + ((i * 7) % 11) / 10,
    phOutlet: 7 + ((i * 3) % 9) / 10,
    doAeration: 1.5 + ((i * 5) % 17) / 10,
    residualChlorine: 0.3 + ((i * 3) % 7) / 10,
  });
  it("flags rows whose lab readings copy the row before, even with fresh flows", () => {
    const es = series(30, (i) => ({ ...lab(i >= 10 && i <= 12 ? 9 : i), inletFlow: distinct(i), outletFlow: distinct(i) - 5 }));
    const f = of(es, "rowcopy");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].entryIds).toEqual([es[10].id, es[11].id, es[12].id]);
    expect(f[0].title).toBe("Rows identical to the previous row");
    expect(f[0].detail).toContain("4 parameters");
  });
  it("does not flag one chance agreement between rows of coarse readings", () => {
    const coarse = (i: number) => ({
      phInlet: [7.2, 7.3][i % 2],
      phOutlet: [7.4, 7.5, 7.4][i % 3],
      doAeration: [2.0, 2.5][(i >> 1) % 2],
      residualChlorine: [0.5, 0.6][(i + (i >> 2)) % 2],
    });
    const es = series(40, (i) => coarse(i === 20 ? 19 : i));
    expect(of(es, "rowcopy"), JSON.stringify(of(es, "rowcopy").map((f) => f.detail))).toHaveLength(0);
  });
  it("needs at least 4 lab readings in the row", () => {
    const three = series(30, (i) => {
      const v = lab(i >= 10 && i <= 14 ? 9 : i);
      return { phInlet: v.phInlet, phOutlet: v.phOutlet, doAeration: v.doAeration, inletFlow: 90, outletFlow: 85 };
    });
    expect(of(three, "rowcopy")).toHaveLength(0);
  });
  it("is not triggered by a row that differs in one lab reading", () => {
    const es = series(30, (i) => ({ ...lab(i >= 10 && i <= 12 ? 9 : i), mlss: 3000 + i }));
    expect(of(es, "rowcopy")).toHaveLength(0);
  });
});

describe("digits", () => {
  it("flags a parameter whose readings mostly end in 0 or 5", () => {
    // 28 of 32 on a half or a whole number, the rest read as displayed
    const f = of(series(32, (i) => ({ phOutlet: i % 8 === 3 ? [7.1, 7.2, 7.3, 7.4][(i >> 3) % 4] : i % 2 ? 7.5 : 7.0 })), "digits");
    expect(f).toHaveLength(1);
    expect(f[0].param).toBe("phOutlet");
    expect(f[0].severity).toBe("medium");
    expect(f[0].detail).toContain("88% of 32");
    expect(f[0].verify).toContain("Outlet pH"); // not "outlet ph"
  });
  it("says once, as a note, when every reading sits on a round step", () => {
    // halves throughout: the method's own resolution, not a habit to chase
    const halves = of(series(32, (i) => ({ phOutlet: i % 2 ? 7.5 : 7.0 })), "digits");
    expect(halves).toHaveLength(1);
    expect(halves[0].id).toBe("digits:phOutlet:all");
    expect(halves[0].severity).toBe("low");
    expect(halves[0].title).toBe("Outlet pH is recorded in steps of 0.5");
    expect(halves[0].detail).toContain("All 32 Outlet pH readings are multiples of 0.5");
    expect(text(halves[0])).not.toMatch(/end in 0 or 5/);
    // pH by paper strip: whole numbers, and it does not matter that they hardly move
    const strip = of(series(40, (i) => ({ phInlet: i % 9 === 4 ? 8 : 7 })), "digits");
    expect(strip).toHaveLength(1);
    expect(strip[0].severity).toBe("low");
    expect(strip[0].title).toBe("Inlet pH is recorded in whole numbers");
    expect(strip[0].verify).toContain("Nothing to correct");
  });
  it("keeps an operator's name out of the title", () => {
    const es = series(
      50,
      (i) => ({ doAeration: i < 20 ? (i % 2 ? 2.5 : 2.0) : 1.1 + ((i * 3) % 10) * 0.2 + ((i * 3) % 10 > 0 ? 0.01 : 0) }),
      (i) => ({ operator: i < 20 ? "Asha K" : "Ravi P" }),
    );
    const f = of(es, "digits");
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("digits:doAeration:op:asha k"); // the id does not depend on the title
    expect(f[0].title).toBe("Aeration tank DO readings mostly end in 0 or 5 (one operator's entries)");
    expect(f[0].title).not.toMatch(/asha/i);
    expect(f[0].detail).toContain("entered under the operator name Asha K");
  });
  it("tests meter readings, whose last digit does not depend on the process", () => {
    // sixteen daily readings that rise by 5 or 10: every one ends in 0 or 5
    const rises = [10, 10, 5, 10, 5, 5, 10, 10, 5, 10, 5, 10, 10, 5, 5];
    let v = 42180;
    const round = daily(16, (i) => {
      if (i > 0) v += rises[i - 1];
      return { energyKwh: v };
    });
    const f = of(round, "digits", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("digits:energyKwh:meter");
    expect(f[0].param).toBe("energyKwh");
    expect(f[0].severity).toBe("medium");
    expect(f[0].entryIds).toHaveLength(16);
    expect(f[0].detail).toContain("All 16 Energy meter readings end in 0 or 5");
    expect(f[0].verify).toContain("counts in fives or tens");
    // the same meter read digit by digit
    let w = 42183;
    const plain = daily(16, (i) => {
      if (i > 0) w += [7, 9, 6, 11, 8, 7, 12, 9, 6, 8, 11, 7, 9, 8, 6][i - 1];
      return { energyKwh: w };
    });
    expect(of(plain, "digits", dailyPlant)).toHaveLength(0);
    // nine readings are too few
    expect(of(round.slice(0, 9), "digits", dailyPlant)).toHaveLength(0);
    // a meter climbing in identical steps of 10 is the step rule's finding, said once
    const tens = daily(20, (i) => ({ energyKwh: 5000 + i * 10 }));
    const both = runChecks(dailyPlant, tens).flags;
    expect(both.filter((x) => x.ruleId === "step")).toHaveLength(1);
    expect(both.filter((x) => x.ruleId === "digits")).toHaveLength(0);
  });
  it("does not flag a normal spread of last digits, or parameters measured in coarse steps", () => {
    expect(of(series(40, (i) => ({ phOutlet: spread(i) })), "digits")).toHaveLength(0);
    const coarse = series(40, (i) => ({ inletFlow: 100 + (i % 2) * 5, mlss: 3000 + (i % 2) * 50, bodOutlet: 10 + (i % 4) * 5, codOutlet: 60 + (i % 5) * 10 }));
    expect(of(coarse, "digits")).toHaveLength(0);
  });
  it("does not flag a steady reading that happens to sit on a round value", () => {
    // outlet pH between 7.4 and 7.6: the last digit is 5 most of the time by position alone
    expect(of(series(40, (i) => ({ phOutlet: [7.5, 7.5, 7.4, 7.5, 7.6, 7.5][i % 6] })), "digits")).toHaveLength(0);
  });
  it("needs 30 values overall", () => {
    expect(of(series(25, (i) => ({ phOutlet: i % 2 ? 7.5 : 7.0 })), "digits")).toHaveLength(0);
  });
  it("tests per operator and states the comparison it actually made", () => {
    const es = series(
      50,
      (i) => ({ doAeration: i < 20 ? (i % 2 ? 2.5 : 2.0) : 1.1 + ((i * 3) % 10) * 0.2 + ((i * 3) % 10 > 0 ? 0.01 : 0) }),
      (i) => ({ operator: i < 20 ? ["Asha K", "asha  k", "ASHA K "][i % 3] : "Ravi P" }),
    );
    const f = of(es, "digits");
    expect(f).toHaveLength(1); // three spellings, one operator
    expect(f[0].id).toBe("digits:doAeration:op:asha k");
    expect(f[0].entryIds).toHaveLength(20);
    expect(f[0].detail).toContain("entered under the operator name Asha K");
    expect(f[0].detail).toMatch(/Among the other 30 readings the share is \d+%/);
  });
  it("makes no claim about other operators when there is nobody to compare with", () => {
    const solo = series(25, (i) => ({ doAeration: i % 2 ? 2.5 : 2.0 }), () => ({ operator: "Asha K" }));
    const f = of(solo, "digits");
    expect(f).toHaveLength(1);
    expect(f[0].detail).not.toMatch(/other/i);
    // when everyone rounds, one overall flag says it and nobody is singled out
    const all = series(60, (i) => ({ doAeration: i % 2 ? 2.5 : 2.0 }), (i) => ({ operator: i % 2 ? "Asha K" : "Ravi P" }));
    const g = of(all, "digits");
    expect(g.map((x) => x.id)).toEqual(["digits:doAeration:all"]);
  });
});

describe("flat", () => {
  // same-shift inflow that swings by well over 10% from day to day
  const swing = (i: number) => Math.round([100, 90, 60][i % 3] * [0.75, 1.0, 1.25, 0.9, 1.2][Math.floor(i / 3) % 5]);
  const moving = (i: number) => 1.5 + ((i * 7) % 19) / 10;
  it("flags a reading that stays within one step while same-shift inflow swings", () => {
    const es = series(60, (i) => ({ doAeration: i < 30 ? (i % 2 ? 2.1 : 2.0) : moving(i), inletFlow: swing(i) }));
    const f = of(es, "flat");
    expect(f).toHaveLength(1);
    expect(f[0].param).toBe("doAeration");
    expect(f[0].severity).toBe("low");
    expect(f[0].entryIds).toEqual(es.slice(0, 30).map((e) => e.id));
    expect(f[0].detail).toContain("Aeration tank DO");
    const long = series(90, (i) => ({ doAeration: i < 55 ? (i % 2 ? 2.1 : 2.0) : moving(i), inletFlow: swing(i) }));
    expect(of(long, "flat")[0].severity).toBe("medium");
  });
  it("never flags pH, which is honestly this steady", () => {
    const es = series(60, (i) => ({ phOutlet: i < 40 ? (i % 2 ? 7.4 : 7.3) : 7 + ((i * 7) % 9) / 10, inletFlow: swing(i) }));
    expect(of(es, "flat")).toHaveLength(0);
  });
  it("is not set off by the daily rhythm of inflow alone", () => {
    // morning 100, evening 90, night 60, the same every day: steady for each shift
    const es = series(60, (i) => ({ doAeration: i < 30 ? (i % 2 ? 2.1 : 2.0) : moving(i), inletFlow: [100, 90, 60][i % 3] + (i % 2) }));
    expect(of(es, "flat")).toHaveLength(0);
  });
  it("needs 25 readings and a spread of no more than one step", () => {
    const short = series(60, (i) => ({ doAeration: i < 24 ? (i % 2 ? 2.1 : 2.0) : moving(i), inletFlow: swing(i) }));
    expect(of(short, "flat")).toHaveLength(0);
    const wider = series(60, (i) => ({ doAeration: i < 30 ? [2.0, 2.1, 2.2][i % 3] : moving(i), inletFlow: swing(i) }));
    expect(of(wider, "flat")).toHaveLength(0);
  });
  it("does not double-report when repeat already covers the entries", () => {
    const es = series(60, (i) => ({ doAeration: i < 30 ? 2.0 : moving(i), inletFlow: swing(i) }));
    expect(of(es, "repeat")).toHaveLength(1);
    expect(of(es, "flat")).toHaveLength(0);
  });
});

describe("missing", () => {
  const full = (days: number) => series(days * 3, () => ({}));
  it("is silent for a complete log", () => {
    const r = runChecks(plant, full(3));
    expect(r.flags.filter((f) => f.ruleId === "missing")).toHaveLength(0);
    expect(r.expectedShifts).toBe(9);
    expect(r.recordedShifts).toBe(9);
  });
  it("flags one missing shift and fills the counts", () => {
    const r = runChecks(plant, full(3).filter((_, i) => i !== 4));
    const f = r.flags.filter((x) => x.ruleId === "missing");
    expect(f).toHaveLength(1);
    expect(f[0].category).toBe("completeness");
    expect(f[0].detail).toContain("2 Sep, shift B");
    expect(r.expectedShifts).toBe(9);
    expect(r.recordedShifts).toBe(8);
  });
  it("merges a contiguous gap into one flag and keeps separate gaps apart", () => {
    const f = of(full(4).filter((_, i) => i !== 4 && i !== 5), "missing");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("2 expected shift entries");
    expect(of(full(4).filter((_, i) => i !== 1 && i !== 7), "missing")).toHaveLength(2);
  });
  it("does not flag shifts that have not happened yet, or came before the first entry", () => {
    // day 1 A, B, C then day 2 A only: B and C of day 2 are still to come
    const r = runChecks(plant, full(2).slice(0, 4));
    expect(r.flags.filter((f) => f.ruleId === "missing")).toHaveLength(0);
    expect(r.expectedShifts).toBe(4);
    expect(r.recordedShifts).toBe(4);
    // a page that begins at shift C
    const late = runChecks(plant, full(2).slice(2));
    expect(late.flags.filter((f) => f.ruleId === "missing")).toHaveLength(0);
    expect(late.expectedShifts).toBe(4);
  });
  it("lets an entry with no shift code stand in for a missing shift", () => {
    const es = full(2).filter((_, i) => i !== 1);
    es.push(E("2026-09-01", null));
    expect(of(es, "missing")).toHaveLength(0);
  });
  it("respects a 2 shift plant, and a night shift written as C there", () => {
    const two: Plant = { ...plant, shiftsPerDay: 2 };
    const es = [E("2026-09-01", "A"), E("2026-09-01", "B"), E("2026-09-02", "A"), E("2026-09-02", "B")];
    expect(of(es, "missing", two)).toHaveLength(0);
    expect(runChecks(two, es).expectedShifts).toBe(4);
    const withC = [0, 1, 2, 3].flatMap((d) => [E(addDays("2026-09-01", d), "A"), E(addDays("2026-09-01", d), "C")]);
    const r = runChecks(two, withC);
    expect(r.flags.filter((f) => f.ruleId === "missing")).toHaveLength(0);
    expect(r.recordedShifts).toBe(8);
    expect(r.expectedShifts).toBe(8);
  });
  it("places readings without a shift letter by their clock time", () => {
    // 09:00 is the morning shift and 23:30 the night shift, so the afternoon is
    // the one that is short, and it is the same on every day: one flag.
    const es = [0, 1, 2, 3, 4].flatMap((d) => [
      E(addDays("2026-09-01", d), null, {}, { time: "09:00" }),
      E(addDays("2026-09-01", d), null, {}, { time: "23:30" }),
    ]);
    const r = runChecks(plant, es);
    const f = r.flags.filter((x) => x.ruleId === "missing");
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("missing:never");
    expect(text(f[0])).not.toMatch(/shift [ABC]\b/);
    expect(f[0].detail).toContain("more than 2 entries");
    expect(r.recordedShifts).toBe(10);
  });
  it("reports reading counts, not shift letters, when the log has no letters", () => {
    const es = [0, 1, 2, 3].flatMap((d) => Array.from({ length: d === 2 ? 2 : 3 }, () => E(addDays("2026-09-01", d), null)));
    const f = of(es, "missing");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("3 Sep has 2");
    expect(text(f[0])).not.toMatch(/shift [ABC]\b/);
  });
  it("says so once when a shift is absent on every day", () => {
    const es = [0, 1, 2, 3, 4, 5].flatMap((d) => [E(addDays("2026-09-01", d), "A"), E(addDays("2026-09-01", d), "B")]);
    const f = of(es, "missing");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("no shift C entry on any of the 6 days");
    expect(f[0].verify).toContain("plant settings");
  });
  it("reports missing days at a one-entry-a-day plant", () => {
    const es = daily(10, () => ({})).filter((_, i) => i !== 3 && i !== 6 && i !== 7);
    const r = runChecks(dailyPlant, es);
    const f = r.flags.filter((x) => x.ruleId === "missing");
    expect(f).toHaveLength(2);
    expect(f[0].title).toBe("Missing day");
    expect(f[0].detail).toBe("There is no entry for 4 Sep.");
    expect(f[1].title).toBe("Missing days");
    expect(f[1].detail).toBe("There are no entries for 2 days, 7 Sep to 8 Sep.");
    expect(r.expectedShifts).toBe(10);
    expect(r.recordedShifts).toBe(7);
    for (const x of f) expect(text(x)).not.toMatch(/shift/i);
  });
  it("keeps finding real gaps when one entry carries a mistyped year", () => {
    const es = full(10).filter((_, i) => i !== 13);
    const stray = E("2062-09-05", "A");
    const r = runChecks(plant, [...es, stray]);
    expect(r.expectedShifts).toBe(30);
    expect(r.recordedShifts).toBe(29);
    const gap = r.flags.filter((f) => f.ruleId === "missing");
    expect(gap).toHaveLength(1);
    expect(gap[0].detail).toContain("5 Sep, shift B");
    const date = r.flags.filter((f) => f.ruleId === "date");
    expect(date).toHaveLength(1);
    expect(date[0].entryIds).toEqual([stray.id]);
    expect(date[0].detail).toContain("2062-09-05");
  });
  it("reports a long break once instead of shift by shift", () => {
    const es = [...full(4), ...full(4).map((e) => ({ ...e, id: `${e.id}-b`, date: addDays(e.date, 100) }))];
    const r = runChecks(plant, es);
    const f = r.flags.filter((x) => x.ruleId === "missing");
    expect(f).toHaveLength(1);
    expect(f[0].title).toBe("Break in the log");
    expect(f[0].detail).toContain("96 days");
    expect(r.expectedShifts).toBe(24);
    expect(r.recordedShifts).toBe(24);
  });
});

describe("date", () => {
  it("flags an entry whose date is not a calendar date, with its id", () => {
    for (const bad of ["garbage", "", "2026-13-01", "2026-02-30", "0026-09-01"]) {
      const stray = E(bad, "A", { tssOutlet: 30 });
      const r = runChecks(plant, [...series(6, () => ({})), stray]);
      const f = r.flags.filter((x) => x.ruleId === "date");
      expect(f, bad).toHaveLength(1);
      expect(f[0].entryIds).toEqual([stray.id]);
      expect(text(f[0])).not.toContain("undefined");
      expect(r.expectedShifts).toBe(6);
    }
  });
  it("still judges the readings of an entry with a bad date", () => {
    const r = runChecks(plant, [E("garbage", null, { tssOutlet: 400 })]);
    expect(r.flags.filter((f) => f.ruleId === "limit")).toHaveLength(1);
    expect(r.flags.find((f) => f.ruleId === "limit")!.detail).not.toContain("undefined");
  });
  it("copes with a log dated in year 0026 without calling its own shifts missing", () => {
    const es = (["A", "B", "C"] as ShiftCode[]).map((s) => E("0026-09-01", s));
    const r = runChecks(plant, es);
    expect(r.flags.filter((f) => f.ruleId === "missing")).toHaveLength(0);
    expect(r.flags.filter((f) => f.ruleId === "date")).toHaveLength(3);
  });
});

describe("duplicate", () => {
  const page = () =>
    series(
      12,
      (i) => ({
        phInlet: 6.8 + ((i * 7) % 11) / 10,
        phOutlet: 7 + ((i * 3) % 9) / 10,
        doAeration: 1.5 + ((i * 5) % 17) / 10,
        residualChlorine: 0.3 + ((i * 3) % 7) / 10,
        tssOutlet: i === 5 ? 140 : 30 + i,
        bodOutlet: i % 3 === 0 ? 12 + i : null,
        mlss: 3000 + i * 10,
        energyKwh: 1000 + 40 * i,
        blowerHours: 6,
      }),
      () => ({ pageId: "pg1", capturedAt: "2026-09-05T10:00:00.000Z" }),
    );
  it("counts a page uploaded twice once, and says so in one flag", () => {
    const first = page();
    const again = first.map((e) => ({ ...e, id: `${e.id}-again`, pageId: "pg2" }));
    const alone = runChecks(plant, first);
    const both = runChecks(plant, [...first, ...again]);
    const dup = both.flags.filter((f) => f.ruleId === "duplicate");
    expect(dup).toHaveLength(1);
    expect(dup[0].severity).toBe("low");
    expect(dup[0].entryIds).toHaveLength(24);
    expect(dup[0].detail).toContain("12 entries");
    // nothing else changes: no row copies, no stalled meter, no doubled counts
    expect(both.flags.filter((f) => f.ruleId !== "duplicate")).toEqual(alone.flags);
    expect(both.flags.some((f) => f.ruleId === "rowcopy" || f.ruleId === "meter" || f.ruleId === "bodfreq")).toBe(false);
    expect(both.recordedShifts).toBe(alone.recordedShifts);
    expect(both.complianceRate).toBe(alone.complianceRate);
  });
  it("reports two entries for the same shift that disagree", () => {
    const es = [E("2026-09-01", "A", { phOutlet: 7.1 }), E("2026-09-01", "A", { phOutlet: 7.6 }), E("2026-09-01", "B", { phOutlet: 7.2 })];
    const f = of(es, "duplicate");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].entryIds).toEqual([es[0].id, es[1].id]);
    expect(runChecks(plant, es).recordedShifts).toBe(2);
  });
  it("does not treat a day's unlabelled rows as duplicates of each other", () => {
    const es = [E("2026-09-01", null, { phOutlet: 7.1 }), E("2026-09-01", null, { phOutlet: 7.1 }), E("2026-09-01", null, { phOutlet: 7.1 })];
    const r = runChecks(plant, es);
    expect(r.flags.filter((f) => f.ruleId === "duplicate")).toHaveLength(0);
    expect(r.recordedShifts).toBe(3);
  });
  it("gives the same result whatever order entries sharing an id arrive in", () => {
    const a = E("2026-09-01", "A", { tssOutlet: 150 });
    const b = { ...a, values: { tssOutlet: 40 } };
    const rest = series(6, () => ({ tssOutlet: 30 })).slice(1);
    expect(runChecks(plant, [a, b, ...rest])).toEqual(runChecks(plant, [b, a, ...rest]));
  });
});

describe("bodfreq", () => {
  it("flags BOD recorded in several shifts on 3 or more days", () => {
    const f = of(series(9, (i) => ({ bodOutlet: 10 + i })), "bodfreq");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].entryIds).toHaveLength(9);
    expect(f[0].detail).toContain("27 °C");
  });
  it("does not flag 2 days, or one BOD per day", () => {
    expect(of(series(6, (i) => ({ bodOutlet: 10 + i })), "bodfreq")).toHaveLength(0);
    expect(of(series(12, (i) => ({ bodOutlet: i % 3 === 0 ? 10 + i : null })), "bodfreq")).toHaveLength(0);
  });
  it("counts shifts, not rows", () => {
    // one BOD a day, but each day's row was entered twice with a corrected pH
    const es = [0, 1, 2, 3].flatMap((d) => [
      E(addDays("2026-09-01", d), "A", { bodOutlet: 12 + d, phOutlet: 7.1 }),
      E(addDays("2026-09-01", d), "A", { bodOutlet: 12 + d, phOutlet: 7.3 }),
    ]);
    expect(of(es, "bodfreq")).toHaveLength(0);
  });
});

describe("meter", () => {
  it("flags any cumulative meter that goes down, as high", () => {
    for (const k of ["energyKwh", "inletTotaliser", "outletTotaliser"] as ParamKey[]) {
      const es = daily(3, (i) => ({ [k]: [1000, 1100, 1050][i] }));
      const f = of(es, "meter", dailyPlant);
      expect(f, k).toHaveLength(1);
      expect(f[0].severity).toBe("high");
      expect(f[0].param).toBe(k);
      expect(f[0].entryIds).toEqual([es[1].id, es[2].id]);
      expect(f[0].verify).toContain("2 Sep and 3 Sep");
    }
  });
  it("names one date, not 'both dates', when the fall is within a day", () => {
    const es = series(3, (i) => ({ energyKwh: [1000, 1100, 1050][i] }));
    const f = of(es, "meter");
    expect(f).toHaveLength(1);
    expect(f[0].verify).toContain("for 1 Sep:");
    expect(f[0].verify).not.toContain("both dates");
  });
  it("treats a fall as a replaced meter when the remarks say so, in English or Hinglish", () => {
    for (const remark of ["meter change", "New meter fitted today", "meter badla", "naya meter lagaya", "energy meter changed, new meter start 90500", "Meter reset by electrician"]) {
      const es = daily(4, (i) => ({ energyKwh: [5000, 5010, 12, 24][i] }), (i) => ({ remarks: i === 2 ? remark : null }));
      const f = of(es, "meter", dailyPlant);
      expect(f, remark).toHaveLength(1);
      expect(f[0].severity).toBe("low");
      expect(f[0].title).toContain("meter replaced, confirm old and new readings");
      expect(f[0].entryIds).toEqual([es[1].id, es[2].id]);
    }
  });
  it("accepts the remark on the neighbouring row", () => {
    for (const at of [1, 3]) {
      const es = daily(5, (i) => ({ energyKwh: [5000, 5010, 12, 24, 36][i] }), (i) => ({ remarks: i === at ? "meter changed" : null }));
      expect(of(es, "meter", dailyPlant)[0].severity, String(at)).toBe("low");
    }
    // two rows away is too far
    const far = daily(5, (i) => ({ energyKwh: [5000, 5010, 12, 24, 36][i] }), (i) => ({ remarks: i === 4 ? "meter changed" : null }));
    expect(of(far, "meter", dailyPlant)[0].severity).toBe("high");
  });
  it("does not let an unrelated remark, or a remark about another meter, excuse a fall", () => {
    const unrelated = daily(4, (i) => ({ energyKwh: [5000, 5010, 12, 24][i] }), (i) => ({ remarks: i === 2 ? "pump serviced, meter ok" : null }));
    expect(of(unrelated, "meter", dailyPlant)[0].severity).toBe("high");
    const other = daily(4, (i) => ({ inletTotaliser: [5000, 5010, 12, 24][i] }), (i) => ({ remarks: i === 2 ? "energy meter changed" : null }));
    expect(of(other, "meter", dailyPlant)[0].severity).toBe("high");
    const flow = daily(4, (i) => ({ inletTotaliser: [5000, 5010, 12, 24][i] }), (i) => ({ remarks: i === 2 ? "inlet flow meter replaced" : null }));
    expect(of(flow, "meter", dailyPlant)[0].severity).toBe("low");
  });
  it("flags a meter that stands still while run hours were recorded, as medium", () => {
    const blower = of(series(3, (i) => ({ energyKwh: i === 0 ? 1000 : 1100, blowerHours: 6 })), "meter");
    expect(blower).toHaveLength(1);
    expect(blower[0].severity).toBe("medium");
    const run = of(daily(4, (i) => ({ inletTotaliser: i < 2 ? 500 + i * 8 : 508, runHours: 6 })), "meter", dailyPlant);
    expect(run).toHaveLength(1);
    expect(run[0].param).toBe("inletTotaliser");
    expect(run[0].entryIds).toHaveLength(2);
  });
  it("accepts a rising meter and a flat one with no run hours", () => {
    expect(of(series(4, (i) => ({ energyKwh: 1000 + i * 50, blowerHours: 6 })), "meter")).toHaveLength(0);
    expect(of(series(3, (i) => ({ energyKwh: i === 0 ? 1000 : 1100, blowerHours: 0 })), "meter")).toHaveLength(0);
    expect(of(daily(3, (i) => ({ energyKwh: i === 0 ? 1000 : 1100 })), "meter", dailyPlant)).toHaveLength(0);
  });
  it("orders clock times as times, not as text", () => {
    const es = [
      E("2026-09-01", null, { energyKwh: 1100 }, { time: "17:00" }),
      E("2026-09-01", null, { energyKwh: 1000 }, { time: "9:00" }),
      E("2026-09-02", null, { energyKwh: 1200 }, { time: "9:00" }),
    ];
    expect(of(es, "meter")).toHaveLength(0);
  });
});

describe("step", () => {
  const rise = (i: number) => 10 + ((i * 7) % 11); // 11 different daily rises
  function meter(n: number, riseAt: (i: number) => number, k: ParamKey = "energyKwh"): LogEntry[] {
    let v = 5000;
    return daily(n, (i) => {
      if (i > 0) v += riseAt(i);
      return { [k]: v };
    });
  }
  it(`flags ${STEP_MIN_N} identical rises in a row and not ${STEP_MIN_N - 1}`, () => {
    const es = meter(40, (i) => (i >= 12 && i < 12 + STEP_MIN_N ? 12 : rise(i) === 12 ? 13 : rise(i)));
    const f = of(es, "step", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].category).toBe("integrity");
    expect(f[0].param).toBe("energyKwh");
    expect(f[0].entryIds).toEqual(es.slice(12, 12 + STEP_MIN_N).map((e) => e.id));
    expect(f[0].detail).toContain("exactly 12 kWh");
    const near = meter(40, (i) => (i >= 12 && i < 11 + STEP_MIN_N ? 12 : rise(i) === 12 ? 13 : rise(i)));
    expect(of(near, "step", dailyPlant)).toHaveLength(0);
  });
  it("covers the flow meters too", () => {
    const es = meter(40, (i) => (i >= 12 && i < 21 ? 8 : rise(i)), "inletTotaliser");
    const f = of(es, "step", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].param).toBe("inletTotaliser");
  });
  it("leaves a meter that does not move to the meter rule", () => {
    const es = meter(40, (i) => (i >= 12 && i < 22 ? 0 : rise(i)));
    expect(of(es, "step", dailyPlant)).toHaveLength(0);
  });
  it("flags a register whose meter climbs by the same amount every single day, once there are enough days", () => {
    // seven readings cannot show what this meter normally does
    expect(of(meter(7, () => 3), "step", dailyPlant)).toHaveLength(0);
    const f = of(meter(15, () => 3), "step", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].entryIds).toHaveLength(14);
    expect(f[0].verify).toContain("timer");
  });
  it("does not flag a meter whose small rises are naturally often equal", () => {
    // 3 or 4 units a day: runs of equal rises are ordinary here
    const rnd = mulberry32(5);
    const small = Array.from({ length: 60 }, () => (rnd() < 0.5 ? 3 : 4));
    for (let i = 20; i < 26; i++) small[i] = 3;
    expect(of(meter(60, (i) => small[i]), "step", dailyPlant)).toHaveLength(0);
  });
});

describe("twin", () => {
  const two = (n: number, same: number) =>
    daily(n, (i) => ({ inletTotaliser: 2000 + i * 8, outletTotaliser: i < same ? 2000 + i * 8 : 1500 + i * 7 }));
  it(`flags inlet and outlet readings that are identical on ${TWIN_MIN_N} entries`, () => {
    const es = two(12, TWIN_MIN_N);
    const f = of(es, "twin", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].category).toBe("plausibility");
    expect(f[0].entryIds).toEqual(es.slice(0, TWIN_MIN_N).map((e) => e.id));
    expect(f[0].verify).toContain("one flow meter or two");
  });
  it(`does not flag ${TWIN_MIN_N - 1}, or a log with only one of the meters`, () => {
    expect(of(two(12, TWIN_MIN_N - 1), "twin", dailyPlant)).toHaveLength(0);
    expect(of(daily(12, (i) => ({ inletTotaliser: 2000 + i * 8 })), "twin", dailyPlant)).toHaveLength(0);
  });
});

describe("flowgap", () => {
  const gap = (n: number, outRise: (i: number) => number) => {
    let out = 900;
    return daily(n, (i) => {
      if (i > 0) out += outRise(i);
      return { inletTotaliser: 1000 + i * 10, outletTotaliser: out };
    });
  };
  it("flags the outlet meter rising over 15% faster than the inlet for 3 entries", () => {
    const es = gap(10, (i) => (i >= 4 && i <= 6 ? 12 : 9));
    const f = of(es, "flowgap", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("medium");
    expect(f[0].entryIds).toEqual([es[4].id, es[5].id, es[6].id]);
    expect(f[0].detail).toContain("36 m³");
    expect(f[0].detail).toContain("30 m³");
  });
  it("does not flag 2 entries, or an excess of 14%", () => {
    expect(of(gap(10, (i) => (i >= 4 && i <= 5 ? 12 : 9)), "flowgap", dailyPlant)).toHaveLength(0);
    expect(of(gap(10, () => 11.4), "flowgap", dailyPlant)).toHaveLength(0);
  });
  it("leaves a falling meter to the meter rule", () => {
    const es = daily(6, (i) => ({ inletTotaliser: [1000, 1010, 20, 30, 40, 50][i], outletTotaliser: 900 + i * 12 }));
    expect(of(es, "flowgap", dailyPlant).every((f) => !f.entryIds.includes(es[2].id))).toBe(true);
  });
});

describe("svi", () => {
  it("flags an implausibly low or high SVI and merges runs", () => {
    const low = of(series(3, () => ({ mlss: 3000, sv30: 60 })), "svi");
    expect(low).toHaveLength(1);
    expect(low[0].entryIds).toHaveLength(3);
    expect(of(series(1, () => ({ mlss: 2000, sv30: 850 })), "svi")).toHaveLength(1);
  });
  it("accepts a normal SVI and needs both readings", () => {
    expect(of(series(3, () => ({ mlss: 3000, sv30: 360 })), "svi")).toHaveLength(0);
    expect(of(series(3, () => ({ mlss: 3000, sv30: null })), "svi")).toHaveLength(0);
    expect(of(series(1, () => ({ mlss: 3000, sv30: 90 })), "svi")).toHaveLength(0); // exactly 30
  });
  it("describes sludge that did not settle as bulking or a test needing dilution, not a wrong reading", () => {
    const f = of(series(1, () => ({ mlss: 1800, sv30: 950 })), "svi");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("did not settle");
    expect(f[0].detail).toContain("severe bulking");
    expect(f[0].detail).not.toContain("probably wrong");
    expect(text(f[0])).not.toContain("30 to 400");
  });
  it("quotes the MLSS and SV30 of the same entry as the SVI it reports", () => {
    const es = series(3, (i) => ({ mlss: [3000, 4000, 3500][i], sv30: [60, 40, 70][i] }));
    const f = of(es, "svi")[0];
    expect(f.detail).toContain("MLSS 4000 mg/L with SV30 40 mL/L");
    expect(f.detail).toContain("SVI of 10 mL/g");
    expect(f.detail).toContain("3 entries in a row");
  });
});

describe("hugging", () => {
  it("flags values packed just under a maximum limit", () => {
    const f = of(series(20, (i) => ({ tssOutlet: 92 + (i % 8) })), "hugging");
    expect(f).toHaveLength(1);
    expect(f[0].param).toBe("tssOutlet");
    expect(text(f[0])).not.toMatch(/genuine/i);
  });
  it("is not applied to pH, where a share of the limit is not a band", () => {
    // 8.1 to 8.6 against 6.5 to 9.0: most of a plant's working range, not a cluster
    expect(of(daily(30, (i) => ({ phOutlet: 8.1 + (i % 6) / 10 })), "hugging", dailyPlant)).toHaveLength(0);
    const etp: Plant = { ...plant, kind: "ETP", limits: DEFAULT_LIMITS.ETP };
    expect(of(series(45, (i) => ({ phOutlet: 8.2 + (i % 6) / 10 })), "hugging", etp)).toHaveLength(0);
    // nor with only a maximum set for it, nor to any limit that has a minimum too
    const maxOnly = { ...plant, limits: { phOutlet: { max: 9 }, phInlet: { max: 9 }, tssOutlet: { min: 5, max: 100 } } } as Plant;
    expect(of(series(20, (i) => ({ phOutlet: 8.5 + (i % 5) / 10, phInlet: 8.5, tssOutlet: 92 + (i % 8) })), "hugging", maxOnly)).toHaveLength(0);
  });
  it("ignores a spread of values, and too few values", () => {
    expect(of(series(20, (i) => ({ tssOutlet: 20 + i * 4 })), "hugging")).toHaveLength(0);
    expect(of(series(14, (i) => ({ tssOutlet: 92 + (i % 8) })), "hugging")).toHaveLength(0);
  });
});

describe("backfill", () => {
  it("notes late digitising once per upload day, at low severity, without blaming anyone", () => {
    const es = series(
      6,
      () => ({}),
      (i) => ({ pageId: i < 4 ? "pg1" : "pg2", capturedAt: "2026-09-20T10:00:00.000Z" }),
    );
    const f = of(es, "backfill");
    expect(f).toHaveLength(1); // a month-end upload of many pages is one note
    expect(f[0].severity).toBe("low");
    expect(f[0].entryIds).toHaveLength(6);
    expect(f[0].detail).toContain("digitised on 20 Sep");
    expect(f[0].detail).toContain("18 to 19 days");
    expect(text(f[0])).not.toMatch(/memory|written up|rough notes/i);
  });
  it("prints a single date once", () => {
    const es = series(2, () => ({}), () => ({ pageId: null, capturedAt: "2026-09-20T10:00:00.000Z" }));
    const f = of(es, "backfill");
    expect(f).toHaveLength(1);
    expect(f[0].detail).toContain("for 1 Sep were");
  });
  it("ignores timely entries, seed data and unreadable capture times", () => {
    expect(of(series(3, () => ({}), () => ({ pageId: "p", capturedAt: "2026-09-03T10:00:00.000Z" })), "backfill")).toHaveLength(0);
    expect(of(series(3, () => ({}), () => ({ pageId: "seed", capturedAt: "2027-01-01T00:00:00.000Z" })), "backfill")).toHaveLength(0);
    expect(of(series(3, () => ({}), () => ({ pageId: "p", capturedAt: "not a time" })), "backfill")).toHaveLength(0);
    expect(of(series(3, () => ({}), () => ({ pageId: "p", capturedAt: undefined as unknown as string })), "backfill")).toHaveLength(0);
  });
});

describe("complianceRate", () => {
  it("is null with no limited readings", () => {
    expect(runChecks(plant, series(3, () => ({ inletFlow: 100 }))).complianceRate).toBeNull();
  });
  it("is the share of limited readings inside the limit", () => {
    const r = runChecks(plant, series(4, (i) => ({ tssOutlet: i === 0 ? 150 : 50 })));
    expect(r.complianceRate).toBeCloseTo(0.75);
  });
  it("agrees with the limit rule about a typo", () => {
    const r = runChecks(plant, series(4, (i) => ({ phOutlet: i === 0 ? 71 : 7.2 })));
    expect(r.flags.filter((f) => f.ruleId === "limit")).toHaveLength(0);
    expect(r.complianceRate).toBe(1);
  });
});

describe("daily meter-and-dosing register", () => {
  it("counts any entry as filling the day, whatever shift letter or time it carries", () => {
    // A daily plant whose rows were once saved with shift letters or times
    // (the setting was changed later, or a page was read as a shift sheet).
    const es = daily(6, (i) => ({ inletTotaliser: 1000 + i * 7 }), (i) => ({
      shift: ([null, "A", "B", "C", null, "B"] as const)[i],
      time: [null, null, "14:00", null, "22:30", null][i],
    }));
    const r = runChecks(dailyPlant, es);
    expect(r.flags.filter((f) => f.ruleId === "missing")).toEqual([]);
    expect([r.recordedShifts, r.expectedShifts]).toEqual([6, 6]);
  });

  // A legitimate small-plant register: both flow meters, timer-driven run
  // hours, the same chemical doses, an energy meter. Nothing here is a lab
  // reading, and identical hours and doses are normal.
  function register(seed: number, days = 45): LogEntry[] {
    const rnd = mulberry32(seed);
    let inlet = 12000;
    let outlet = 11000.5;
    let energy = 60000;
    return daily(days, (i) => {
      const q = 6 + Math.floor(rnd() * 5);
      inlet += q;
      outlet += q * (0.92 + 0.05 * rnd());
      energy += 9 + Math.floor(rnd() * 6);
      return {
        inletTotaliser: inlet,
        outletTotaliser: Math.floor(outlet),
        runHours: 6,
        limeKg: 0.5,
        alumKg: 0.5,
        chlorineKg: 0.1,
        energyKwh: energy,
        sludgeKg: i % 7 === 0 ? 4 : null,
      };
    }, () => ({ operator: "Sunil" }));
  }
  it("raises nothing on a legitimate register with identical run hours and doses", () => {
    let withAnyFlag = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const r = runChecks(dailyPlant, register(seed));
      const ids = r.flags.map((f) => f.ruleId);
      for (const rule of ["repeat", "rowcopy", "digits", "flat", "twin", "flowgap", "meter", "missing", "physical"]) {
        expect(ids, `seed ${seed}: ${r.flags.map((f) => f.id).join(", ")}`).not.toContain(rule);
      }
      if (r.flags.length) withAnyFlag++;
      expect(r.expectedShifts).toBe(45);
      expect(r.recordedShifts).toBe(45);
      expect(r.complianceRate).toBeNull();
    }
    // the step rule is allowed its small chance of a fluke, nothing more
    expect(withAnyFlag).toBeLessThanOrEqual(2);
  });
  it("never says 'shift' at a one-entry-a-day plant", () => {
    const es = register(3, 40).filter((_, i) => i !== 9);
    es[12].values.outletTotaliser = (es[12].values.outletTotaliser as number) - 400; // meter falls
    es[15].values.runHours = 30;
    es[18].values.phOutlet = 5.1; // a limit breach
    for (let i = 20; i < 26; i++) es[i].values.outletTotaliser = es[i].values.inletTotaliser;
    es.push({ ...es[30], id: "again", values: { ...es[30].values, runHours: 5 } }); // same day, different row
    es.push(E("2026-09-04", null, { bodOutlet: 60, codOutlet: 40 }));
    const flags = runChecks(dailyPlant, es).flags;
    const rules = new Set(flags.map((f) => f.ruleId));
    for (const rule of ["missing", "meter", "physical", "limit", "twin", "duplicate"]) expect(rules.has(rule), rule).toBe(true);
    for (const f of flags) expect(text(f), f.id).not.toMatch(/shift/i);
  });
  it("accepts a shift letter or a clock time on a daily row without confusion", () => {
    const es = daily(6, (i) => ({ energyKwh: 1000 + i * 11 }), (i) => ({ shift: i % 2 ? "A" : null, time: i % 3 ? "10:30" : null }));
    const r = runChecks(dailyPlant, es);
    expect(r.flags).toHaveLength(0);
    expect(r.recordedShifts).toBe(6);
  });
});

describe("false positives on normal data", () => {
  // A month of ordinary three-shift readings: nothing copied, nothing rounded
  // by habit. Outlet pH is recorded to one decimal with the given spread, which
  // is what made the old fixed "4 identical readings" rule fire on nearly
  // every month.
  function normalMonth(seed: number, phSigma: number): LogEntry[] {
    const rnd = mulberry32(seed);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-9))) * Math.cos(2 * Math.PI * rnd());
    const r1 = (v: number) => Math.round(v * 10) / 10;
    let energy = 40000;
    return series(
      90,
      (i) => {
        const morning = i % 3 === 0;
        const labDay = Math.floor(i / 3) % 7 === 1 || Math.floor(i / 3) % 7 === 3 || Math.floor(i / 3) % 7 === 5;
        const inlet = Math.round(232 * [0.42, 0.36, 0.22][i % 3] * (1 + 0.07 * g()));
        const mlss = Math.round((3200 + 150 * g()) / 10) * 10;
        const blower = r1(Math.min(8, Math.max(5, 6.8 + 0.8 * g())));
        energy += Math.round(blower * 11 + 8 + 4 * g());
        return {
          inletFlow: inlet,
          outletFlow: Math.round(inlet * 0.95 * (1 + 0.03 * g())),
          phInlet: r1(7.3 + 0.25 * g()),
          phOutlet: r1(7.3 + phSigma * g()),
          doAeration: r1(Math.max(0.5, 2.5 + 0.4 * g())),
          residualChlorine: r1(Math.min(1.5, Math.max(0.1, 0.6 + 0.12 * g()))),
          mlss: morning ? mlss : null,
          sv30: morning ? Math.round((mlss * (110 + 12 * g())) / 1000) : null,
          codOutlet: morning && labDay ? Math.round(75 + 15 * g()) : null,
          tssOutlet: morning && labDay ? Math.round(24 + 6 * g()) : null,
          blowerHours: blower,
          energyKwh: energy,
        };
      },
      (i) => ({ operator: ["Asha", "Ravi", "Imran"][(i + Math.floor(i / 21)) % 3] }),
    );
  }
  const MONTHS = 200;
  for (const sigma of [0.05, 0.1, 0.15]) {
    it(`flags fewer than 2% of ordinary months when outlet pH spreads by ${sigma}`, () => {
      const hits: string[] = [];
      for (let m = 0; m < MONTHS; m++) {
        const flags = runChecks(plant, normalMonth(1000 * sigma * 100 + m, sigma)).flags;
        if (flags.length) hits.push(`${m}: ${flags.map((f) => `${f.id} (${f.severity})`).join(", ")}`);
      }
      expect(hits.length / MONTHS, hits.join("\n")).toBeLessThan(0.02);
    });
  }
});

describe("messy input", () => {
  it("handles an empty list, a missing list and holes in the list", () => {
    const empty = { flags: [], expectedShifts: 0, recordedShifts: 0, complianceRate: null };
    expect(runChecks(plant, [])).toEqual(empty);
    expect(runChecks(plant, undefined as unknown as LogEntry[])).toEqual(empty);
    expect(runChecks(plant, [null, undefined] as unknown as LogEntry[])).toEqual(empty);
    expect(() => runChecks(undefined as unknown as Plant, [E("2026-09-01", "A", { phOutlet: 7 })])).not.toThrow();
  });
  it("handles a single entry, all-null values and a missing values object", () => {
    expect(() => runChecks(plant, [E("2026-09-01", "A", { phOutlet: 7 })])).not.toThrow();
    const nulls = series(39, () =>
      Object.fromEntries(
        ["inletFlow", "phOutlet", "bodOutlet", "energyKwh", "mlss", "sv30", "inletTotaliser", "runHours"].map((k) => [k, null]),
      ) as Partial<Record<ParamKey, number | null>>,
    );
    const r = runChecks(plant, nulls);
    expect(r.flags).toHaveLength(0);
    expect(r.complianceRate).toBeNull();
    const bare = series(3, () => ({})).map((e) => ({ ...e, values: undefined as unknown as LogEntry["values"] }));
    expect(runChecks(plant, bare).flags).toHaveLength(0);
  });
  it("ignores NaN, Infinity and text where a number should be", () => {
    const es = series(6, (i) => ({
      phOutlet: [Number.NaN, Infinity, -Infinity, "7.2" as unknown as number, 7.1, 7.3][i],
      energyKwh: [1000, Number.NaN, 1100, Infinity, 1200, 1300][i],
    }));
    const r = runChecks(plant, es);
    expect(r.flags).toHaveLength(0);
    expect(r.complianceRate).toBe(1);
  });
  it("reports absurdly large values without breaking anything else", () => {
    const es = series(4, (i) => ({ tssOutlet: i === 1 ? 1e300 : 30, energyKwh: i === 2 ? 1e15 : 1000 + i, mlss: 3000, sv30: 300 }));
    const r = runChecks(plant, es);
    expect(r.flags.filter((f) => f.ruleId === "physical").length).toBeGreaterThanOrEqual(2);
    for (const f of r.flags) expect(text(f)).not.toMatch(/NaN|undefined|Infinity/);
  });
  it("gives the same result for shuffled input", () => {
    const es = series(30, (i) => ({
      phOutlet: i < 6 ? 7.2 : spread(i),
      inletFlow: i >= 10 && i < 16 ? 80 : distinct(i),
      tssOutlet: i === 20 ? 130 : 30,
      energyKwh: 1000 + i * 40 - (i === 25 ? 500 : 0),
    }));
    const shuffled = [...es].sort((a, b) => ((a.id.length * 7 + a.id.charCodeAt(2)) % 5) - ((b.id.length * 7 + b.id.charCodeAt(2)) % 5)).reverse();
    const a = runChecks(plant, es);
    expect(runChecks(plant, shuffled)).toEqual(a);
    expect(a.flags.length).toBeGreaterThanOrEqual(3);
  });
  it("tolerates duplicate date and shift, counting the slot once", () => {
    const es = [E("2026-09-01", "A"), E("2026-09-01", "A"), E("2026-09-01", "B"), E("2026-09-01", "C")];
    const r = runChecks(plant, es);
    expect(r.expectedShifts).toBe(3);
    expect(r.recordedShifts).toBe(3);
    expect(r.flags.filter((f) => f.ruleId === "missing")).toHaveLength(0);
  });
  it("tolerates odd dates, odd shifts and odd plant settings", () => {
    const odd = [
      E("garbage", null),
      E(null as unknown as string, "A"),
      E("2026-09-01", "Z" as unknown as ShiftCode, {}, { time: "25:99" }),
      E("2026-09-01", "A", {}, { operator: 42 as unknown as string, remarks: 7 as unknown as string }),
    ];
    expect(() => runChecks(plant, odd)).not.toThrow();
    for (const perDay of [0, 5, undefined, "3"]) {
      expect(() => runChecks({ ...plant, shiftsPerDay: perDay as unknown as 1 }, series(9, () => ({ phOutlet: 7 })))).not.toThrow();
    }
  });
  it("does not print markup-like remarks back unescaped beyond a short quote", () => {
    const remark = `meter changed <img src=x onerror=alert(1)> ${"x".repeat(500)}`;
    const es = daily(3, (i) => ({ energyKwh: [5000, 12, 24][i] }), (i) => ({ remarks: i === 1 ? remark : null }));
    const f = of(es, "meter", dailyPlant)[0];
    expect(f.severity).toBe("low");
    expect(f.detail.length).toBeLessThan(400); // quoted, and cut short
  });
  it("survives 300 random logs of bad dates, blanks, duplicates and junk, in any order", () => {
    const rnd = mulberry32(2026);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const junk = [null, undefined, Number.NaN, Infinity, -1, 0, 1e12, 1e306, 1e-9, "12" as unknown as number];
    const keys: ParamKey[] = ["inletFlow", "outletFlow", "phOutlet", "doAeration", "mlss", "sv30", "codOutlet", "bodOutlet", "tssOutlet", "blowerHours", "energyKwh", "inletTotaliser", "outletTotaliser", "runHours", "limeKg", "chlorineKg", "sludgeKg"];
    const capacities = [250, 10, 0, -1, 1e-9, 1e12, Number.NaN, Infinity, undefined, null, "250", "x"] as unknown as number[];
    for (let run = 0; run < 300; run++) {
      const n = Math.floor(rnd() * 40);
      const es: LogEntry[] = [];
      for (let i = 0; i < n; i++) {
        const values: LogEntry["values"] = {};
        for (const k of keys) {
          const u = rnd();
          if (u < 0.5) values[k] = Math.round(rnd() * 200) / (k === "phOutlet" ? 10 : 1);
          else if (u < 0.6) values[k] = pick(junk);
        }
        es.push(
          E(
            pick([addDays("2026-09-01", Math.floor(rnd() * 12)), addDays("2026-09-01", Math.floor(rnd() * 12)), addDays("2026-09-01", Math.floor(rnd() * 12)), "2026-10-07", "2025-09-03", "2062-01-01", "", "2026-02-30", "x"]),
            pick(["A", "B", "C", null, null, "Q" as unknown as ShiftCode]),
            values,
            {
              time: pick([null, null, "9:00", "23:30", "noon"]),
              operator: pick([null, "Asha", " asha ", ""]),
              remarks: pick([null, "new meter", "ok", "meter not changed", "मीटर बदला", "meter ".repeat(3000)]),
              pageId: pick([null, "pg1", "pg2", "seed"]),
              capturedAt: pick(["2026-09-30T10:00:00.000Z", "2026-09-02T10:00:00.000Z", "2031-01-01T00:00:00.000Z", "?"]),
            },
          ),
        );
      }
      // some exact re-uploads and some repeated ids
      for (let i = 0; i < n; i += 7) es.push({ ...es[i], id: rnd() < 0.5 ? es[i].id : `${es[i].id}-copy` });
      const p: Plant = { ...plant, shiftsPerDay: pick([1, 2, 3]), kind: pick(["STP", "ETP"]), capacityKld: pick(capacities) };
      const a = runChecks(p, es);
      const b = runChecks(p, [...es].reverse());
      expect(b, `run ${run}`).toEqual(a);
      expect(new Set(a.flags.map((f) => f.id)).size, `run ${run}`).toBe(a.flags.length);
      expect(a.recordedShifts).toBeLessThanOrEqual(a.expectedShifts);
      if (a.complianceRate !== null) {
        expect(a.complianceRate).toBeGreaterThanOrEqual(0);
        expect(a.complianceRate).toBeLessThanOrEqual(1);
      }
      for (const f of a.flags) {
        expect(text(f), `run ${run} ${f.id}`).not.toMatch(/undefined|NaN|\[object/);
        expect(text(f), `run ${run} ${f.id}`).not.toMatch(/\bnull\b/);
        expect(RULES.some((r) => r.id === f.ruleId && r.category === f.category), f.id).toBe(true);
        for (const id of f.entryIds) expect(typeof id).toBe("string");
        if (f.date !== undefined) expect(f.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });
  it("runs 5,000 entries in well under a second", () => {
    const rnd = mulberry32(9);
    let energy = 0;
    const es = Array.from({ length: 5000 }, (_, i) => {
      const s = slot(i);
      energy += 60 + Math.floor(rnd() * 30);
      return E(s.date, s.shift, {
        inletFlow: 60 + Math.floor(rnd() * 60),
        phOutlet: Math.round((7.3 + (rnd() - 0.5) * 0.6) * 10) / 10,
        doAeration: Math.round((2.5 + (rnd() - 0.5) * 2) * 10) / 10,
        tssOutlet: 20 + Math.floor(rnd() * 30),
        energyKwh: energy,
        blowerHours: 6,
      });
    });
    runChecks(plant, es.slice(0, 200)); // warm up
    const t = performance.now();
    const r = runChecks(plant, es);
    const ms = performance.now() - t;
    expect(ms, `${ms} ms`).toBeLessThan(1000);
    expect(r.expectedShifts).toBe(5000);
  });
});

describe("missing: a register that does not match the plant setting", () => {
  const noLetters = (f: Flag) => expect(text(f), f.id).not.toMatch(/shift [ABC]\b/);
  it("reports a one-row-a-day register at a two- or three-shift plant once, not day by day", () => {
    for (const perDay of [2, 3] as const) {
      const p: Plant = { ...plant, shiftsPerDay: perDay };
      const r = runChecks(p, daily(30, () => ({})).filter((_, i) => i !== 11));
      const f = r.flags.filter((x) => x.ruleId === "missing");
      expect(f.map((x) => x.id), String(perDay)).toEqual(["missing:never", "missing:2026-09-12:A"]);
      expect(f[0].title).toBe("Fewer entries a day than the plant setting");
      expect(f[0].detail).toContain("has more than 1 entry");
      expect(f[0].detail).toContain(`set to ${perDay} entries a day`);
      // only the day that falls short of what the register itself records
      expect(f[1].detail).toContain("1 expected entry is missing on 12 Sep");
      expect(f[1].detail).toContain("The other days in the log have 1 entry each; 12 Sep has none");
      // and the count follows the register, not the setting
      expect([r.recordedShifts, r.expectedShifts]).toEqual([29, 30]);
      f.forEach(noLetters);
    }
  });
  it("does the same for two unlabelled rows a day at a three-shift plant", () => {
    const two = (skip: number | null) =>
      Array.from({ length: 20 }, (_, d) => d).flatMap((d) =>
        Array.from({ length: d === skip ? 1 : 2 }, () => E(addDays("2026-09-01", d), null, { phOutlet: 7.1 + (d % 5) / 10 })),
      );
    const full = runChecks(plant, two(null));
    const f = full.flags.filter((x) => x.ruleId === "missing");
    expect(f.map((x) => x.id)).toEqual(["missing:never"]);
    expect(f[0].detail).toContain("No day in the log (20 days) has more than 2 entries");
    expect([full.recordedShifts, full.expectedShifts]).toEqual([40, 40]);
    const short = runChecks(plant, two(7));
    const g = short.flags.filter((x) => x.ruleId === "missing");
    expect(g.map((x) => x.id)).toEqual(["missing:never", "missing:2026-09-08:B"]);
    expect(g[1].detail).toContain("1 expected entry is missing on 8 Sep");
    expect(g[1].detail).toContain("8 Sep has 1");
    expect([short.recordedShifts, short.expectedShifts]).toEqual([39, 40]);
    g.forEach(noLetters);
  });
  it("does not expect more of a short first day than it has", () => {
    // the page starts with the last reading of its first day
    const es = [0, 1, 2, 3, 4].flatMap((d) => Array.from({ length: d === 0 ? 1 : 3 }, () => E(addDays("2026-09-01", d), null)));
    const r = runChecks(plant, es);
    expect(r.flags.filter((x) => x.ruleId === "missing")).toEqual([]);
    expect([r.recordedShifts, r.expectedShifts]).toEqual([13, 13]);
  });
  it("says once when most days carry more rows than the setting allows", () => {
    // a three-shift sheet saved at a plant set to one entry a day
    const es = series(30, (i) => ({ phOutlet: 7 + (i % 7) / 10 }));
    const r = runChecks(dailyPlant, es);
    const over = r.flags.filter((x) => x.id === "missing:over");
    expect(over).toHaveLength(1);
    expect(over[0].severity).toBe("medium");
    expect(over[0].title).toBe("More entries a day than the plant setting");
    expect(over[0].detail).toContain("10 of the 10 days in the log have more than 1 entry (up to 3 a day)");
    expect(over[0].verify).toContain("plant settings");
    for (const f of r.flags) expect(text(f), f.id).not.toMatch(/shift/i);
    // two unlabelled rows a day there: the same one flag, not a conflict a day
    const twice = [0, 1, 2, 3, 4, 5].flatMap((d) => [0, 1].map((x) => E(addDays("2026-09-01", d), null, { runHours: 5 + x })));
    const t = runChecks(dailyPlant, twice).flags;
    expect(t.filter((x) => x.id === "missing:over")).toHaveLength(1);
    expect(t.filter((x) => x.ruleId === "duplicate")).toHaveLength(0);
    // one such day in a week is still a conflict to sort out
    const once = [...daily(7, () => ({ runHours: 6 })), E("2026-09-03", null, { runHours: 4 })];
    const o = runChecks(dailyPlant, once).flags;
    expect(o.filter((x) => x.id === "missing:over")).toHaveLength(0);
    expect(o.filter((x) => x.ruleId === "duplicate")).toHaveLength(1);
  });
  it("does not use shift wording for lettered rows at a one-entry-a-day plant", () => {
    // the same values night after night, on rows that still carry shift letters
    const es = series(60, (i) => ({ phInlet: i % 3 === 2 && i >= 15 && i < 39 ? 7.4 : spread(i), inletFlow: distinct(i) % 9 }));
    for (const f of runChecks(dailyPlant, es).flags) expect(text(f), f.id).not.toMatch(/shift/i);
  });
});

describe("step: broken runs and several meters", () => {
  // The inlet and outlet columns carry the same reading and rise by 9 a day;
  // the energy meter rises by 3 a day.
  const reg = (n: number, outlet = (i: number) => 5000 + 9 * i) =>
    daily(n, (i) => ({ inletTotaliser: 5000 + 9 * i, outletTotaliser: outlet(i), energyKwh: 800 + 3 * i, runHours: 6 }));
  const params = (f: Flag[]) => f.map((x) => x.param).sort();
  it("still reports identical steps when a day is missing", () => {
    const f = of(reg(30).filter((_, i) => i !== 14), "step", dailyPlant);
    expect(params(f)).toEqual(["energyKwh", "inletTotaliser", "outletTotaliser"]);
    const energy = f.find((x) => x.param === "energyKwh")!;
    expect(energy.entryIds).toHaveLength(28);
    expect(energy.detail).toContain("rose by exactly 3 kWh in 28 of its 28 rises");
    expect(energy.detail).toContain("1 of these is a rise of the same amount per day across days with no entry");
  });
  it("still reports them when one reading was misread", () => {
    const es = reg(30);
    es[14].values.energyKwh = (es[14].values.energyKwh as number) + 10;
    const flags = runChecks(dailyPlant, es).flags;
    const energy = flags.find((x) => x.ruleId === "step" && x.param === "energyKwh")!;
    expect(energy, flags.map((x) => x.id).join(", ")).toBeDefined();
    expect(energy.detail).toContain("in 27 of its 28 rises");
    expect(energy.detail).toContain("The other rise: 13 kWh on 15 Sep");
    expect(energy.entryIds).not.toContain(es[14].id);
    expect(flags.some((x) => x.id.startsWith("meter:down:energyKwh"))).toBe(true);
  });
  it("still reports them across regular gaps and rest days", () => {
    // 60 rows rising by 3 a row, with a day skipped after every twelfth row
    const gaps = Array.from({ length: 60 }, (_, i) => E(addDays("2026-07-01", i + Math.floor(i / 12)), null, { energyKwh: 800 + 3 * i }));
    const g = of(gaps, "step", dailyPlant);
    expect(g).toHaveLength(1);
    expect(g[0].entryIds).toHaveLength(59);
    // 60 rows: +3 on working days, nothing on Sundays, when the plant did not run
    let v = 800;
    const rest = Array.from({ length: 60 }, (_, i) => {
      const sunday = i % 7 === 6;
      if (i > 0 && !sunday) v += 3;
      return E(addDays("2026-07-01", i), null, { energyKwh: v, runHours: sunday ? 0 : 6 });
    });
    const flags = runChecks(dailyPlant, rest).flags;
    const s = flags.filter((x) => x.ruleId === "step");
    expect(s).toHaveLength(1);
    expect(s[0].detail).toContain("rose by exactly 3 kWh in 51 of its 51 rises");
    expect(flags.filter((x) => x.ruleId === "meter")).toHaveLength(0);
  });
  it("needs fewer rows the more meters step together", () => {
    const one = (n: number) => daily(n, (i) => ({ energyKwh: 800 + 3 * i }));
    expect(of(one(8), "step", dailyPlant)).toHaveLength(0);
    expect(of(one(9), "step", dailyPlant)).toHaveLength(1);
    // inlet and outlet written with the same figure count as one meter: with
    // the energy meter that is two, and a single ten-row page is enough
    expect(of(reg(6), "step", dailyPlant)).toHaveLength(0);
    expect(params(of(reg(7), "step", dailyPlant))).toEqual(["energyKwh", "inletTotaliser", "outletTotaliser"]);
    expect(of(reg(10), "step", dailyPlant)).toHaveLength(3);
    // one stepping meter beside two that vary is judged on its own
    const mixed = (n: number) =>
      daily(n, (i) => ({ energyKwh: 800 + 3 * i, inletTotaliser: 5000 + 9 * i + ((i * 7) % 5), outletTotaliser: 4000 + 8 * i + ((i * 3) % 4) }));
    expect(of(mixed(10), "step", dailyPlant)).toHaveLength(0);
    expect(params(of(mixed(11), "step", dailyPlant))).toEqual(["energyKwh"]);
  });
  it("judges two meters stepping over the same entries together", () => {
    // each meter's ordinary rises overlap its planted step, so neither run is
    // remarkable alone
    const eRise = (i: number) => (i >= 12 && i < 19 ? 12 : [10, 11, 13][i % 3]);
    const iRise = (i: number) => (i >= 12 && i < 19 ? 8 : [6, 7, 9][(i + 1) % 3]);
    const build = (withEnergy: boolean) => {
      let e = 9000;
      let q = 3000;
      return daily(40, (i) => {
        if (i > 0) {
          e += eRise(i);
          q += iRise(i);
        }
        return withEnergy ? { energyKwh: e, inletTotaliser: q } : { inletTotaliser: q };
      });
    };
    expect(of(build(false), "step", dailyPlant)).toHaveLength(0);
    const f = of(build(true), "step", dailyPlant);
    expect(params(f)).toEqual(["energyKwh", "inletTotaliser"]);
    for (const x of f) expect(x.entryIds.length).toBeGreaterThanOrEqual(7);
    expect(f.find((x) => x.param === "inletTotaliser")!.detail).toContain("Energy meter rises in identical steps over the same entries");
  });
  it("leaves alone a small meter whose rises are mostly, but not nearly all, the same", () => {
    // 3 most days, 4 or 5 on others: fourteen rows of a small plant's energy meter
    const rises = [3, 3, 4, 3, 3, 4, 5, 3, 3, 4, 3, 5, 3];
    let v = 2000;
    const es = daily(14, (i) => {
      if (i > 0) v += rises[i - 1];
      return { energyKwh: v };
    });
    expect(of(es, "step", dailyPlant)).toHaveLength(0);
  });
});

describe("coarse columns (paper strips, comparator kits)", () => {
  // A small three-shift plant that measures pH with paper strips (whole
  // numbers) and chlorine with a comparator kit (0.2, 0.5 or 1.0), and reads
  // DO, flows and the energy meter from instruments.
  function stripMonth(seed: number): LogEntry[] {
    const rnd = mulberry32(seed);
    const g = () => Math.sqrt(-2 * Math.log(Math.max(rnd(), 1e-9))) * Math.cos(2 * Math.PI * rnd());
    const strip = () => {
      const u = rnd();
      return u < 0.85 ? 7 : u < 0.925 ? 6 : 8;
    };
    const kit = () => {
      const u = rnd();
      return u < 0.8 ? 0.5 : u < 0.9 ? 0.2 : 1.0;
    };
    let energy = 40000;
    return series(
      90,
      (i) => {
        const inlet = Math.round(232 * [0.42, 0.36, 0.22][i % 3] * (1 + 0.07 * g()));
        const blower = Math.round(Math.min(8, Math.max(5, 6.8 + 0.8 * g())) * 10) / 10;
        energy += Math.round(blower * 11 + 8 + 4 * g());
        return {
          inletFlow: inlet,
          outletFlow: Math.round(inlet * 0.95 * (1 + 0.03 * g())),
          phInlet: strip(),
          phOutlet: strip(),
          doAeration: Math.round(Math.max(0.5, 2.5 + 0.4 * g()) * 10) / 10,
          residualChlorine: kit(),
          blowerHours: blower,
          energyKwh: energy,
        };
      },
      (i) => ({ operator: ["Asha", "Ravi", "Imran"][(i + Math.floor(i / 21)) % 3] }),
    );
  }
  it("raises nothing but resolution notes on 200 months of such a plant", () => {
    const hits: string[] = [];
    let notes = 0;
    for (let m = 0; m < 200; m++) {
      const flags = runChecks(plant, stripMonth(7000 + m)).flags;
      // a strip reading 6 at the outlet is below the pH limit, and rightly reported
      const loud = flags.filter((f) => f.severity !== "low" && f.ruleId !== "limit");
      if (loud.length) hits.push(`${m}: ${loud.map((f) => `${f.id} (${f.severity})`).join(", ")}`);
      for (const f of flags.filter((x) => x.severity === "low")) {
        expect(f.ruleId, f.id).toBe("digits");
        expect(f.title).toMatch(/is recorded in (whole numbers|a few fixed steps)/);
        notes++;
      }
    }
    expect(hits.length / 200, hits.join("\n")).toBeLessThan(0.02);
    // the two pH columns and the chlorine column, once each
    expect(notes).toBe(600);
  });
  it("does not make a high flag of a strip that always reads 7 and a kit that always reads 0.5", () => {
    const rnd = mulberry32(3);
    const es = series(90, () => ({ phInlet: 7, phOutlet: 7, residualChlorine: 0.5, doAeration: Math.round((2 + rnd() * 1.5) * 10) / 10 }));
    const flags = runChecks(plant, es).flags;
    expect(flags.filter((f) => f.severity === "high").map((f) => f.id)).toEqual([]);
    for (const f of flags.filter((x) => x.ruleId === "repeat")) {
      expect(f.severity).toBe("medium");
      expect(f.detail).toContain("recorded in coarse steps");
    }
  });
  it("is high again as soon as a finely recorded reading repeats with them", () => {
    const rnd = mulberry32(4);
    const es = series(90, (i) => ({
      phInlet: 7,
      phOutlet: i % 11 === 5 ? 8 : 7,
      inletFlow: i >= 40 && i < 48 ? 77 : 60 + Math.floor(rnd() * 50),
      doAeration: i >= 40 && i < 48 ? 2.3 : Math.round((2 + rnd() * 1.5) * 10) / 10,
    }));
    const f = of(es, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(f[0].detail).toContain("Inlet flow");
    expect(f[0].detail).not.toContain("coarse steps");
  });
  it("still flags a column stuck on a value that is not a round step", () => {
    const f = of(series(30, () => ({ phInlet: 7.2 })), "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].detail).not.toContain("coarse steps");
  });
});

describe("date: a slip of one month", () => {
  const month = () => {
    let energy = 3000;
    return series(60, (i) => {
      energy += 40 + ((i * 7) % 13);
      return { energyKwh: energy, phOutlet: spread(i) };
    });
  };
  it("questions one entry a month out instead of reporting weeks of missing shifts", () => {
    const es = month();
    const at = es.findIndex((e) => e.date === "2026-09-11" && e.shift === "A");
    es[at] = { ...es[at], date: "2026-10-11" };
    const r = runChecks(plant, es);
    const date = r.flags.filter((f) => f.ruleId === "date");
    expect(date).toHaveLength(1);
    expect(date[0].entryIds).toEqual([es[at].id]);
    expect(date[0].severity).toBe("medium");
    expect(date[0].title).toBe("Entry date looks out of place");
    expect(date[0].detail).toContain("dated 2026-10-11, 21 days after the other entries (2026-09-01 to 2026-09-20)");
    expect(date[0].detail).toContain("There is no shift A entry for 11 Sep 2026, the same day a month earlier");
    expect(date[0].detail).toContain("Energy meter on this entry");
    expect(date[0].detail).toContain("belongs between the readings of 10 Sep, shift C and 11 Sep, shift B");
    expect(date[0].verify).toContain("especially the month");
    // the only gap is the slot the entry belongs in, and the meter never fell
    const missing = r.flags.filter((f) => f.ruleId === "missing");
    expect(missing.map((f) => f.detail)).toEqual(["1 expected shift entry is missing: 11 Sep, shift A."]);
    expect(r.flags.filter((f) => f.ruleId === "meter")).toHaveLength(0);
    expect([r.recordedShifts, r.expectedShifts]).toEqual([59, 60]);
  });
  it("does the same at a one-entry-a-day plant, before the log as well as after it", () => {
    for (const [from, to, words] of [
      ["2026-09-11", "2026-10-11", "a month earlier"],
      ["2026-09-21", "2026-08-21", "a month later"],
    ]) {
      const es = daily(30, (i) => ({ inletTotaliser: 4000 + i * 8 + ((i * 5) % 3) }));
      const at = es.findIndex((e) => e.date === from);
      es[at] = { ...es[at], date: to };
      const r = runChecks(dailyPlant, es);
      const date = r.flags.filter((f) => f.ruleId === "date");
      expect(date, to).toHaveLength(1);
      expect(date[0].entryIds).toEqual([es[at].id]);
      expect(date[0].detail).toContain(`the same day ${words}`);
      expect(r.flags.filter((f) => f.ruleId === "missing").map((f) => f.title)).toEqual(["Missing day"]);
      expect(r.flags.filter((f) => f.ruleId === "meter")).toHaveLength(0);
      expect([r.recordedShifts, r.expectedShifts]).toEqual([29, 30]);
      for (const f of r.flags) expect(text(f), f.id).not.toMatch(/shift/i);
    }
  });
  it("leaves alone an entry that simply follows a quiet fortnight", () => {
    // logging starts again on 4 Oct: the meter has moved on and no earlier day is empty
    const es = [...daily(20, (i) => ({ energyKwh: 1000 + i * 11 + (i % 3) })), E("2026-10-04", null, { energyKwh: 1420 })];
    const r = runChecks(dailyPlant, es);
    expect(r.flags.filter((f) => f.ruleId === "date")).toHaveLength(0);
    const gap = r.flags.filter((f) => f.ruleId === "missing");
    expect(gap).toHaveLength(1);
    expect(gap[0].detail).toBe("There are no entries for 13 days, 21 Sep to 3 Oct.");
    // but the gap flag says what else it could be
    expect(gap[0].verify).toContain("Only 1 entry follows this gap: if it carries the wrong date, correct the date instead.");
  });
  it("needs a log to compare with", () => {
    const es = [...daily(4, (i) => ({ energyKwh: 1000 + i * 11 })), E("2026-10-02", null, { energyKwh: 1011 })];
    expect(of(es, "date", dailyPlant)).toHaveLength(0);
  });
});

describe("dates are printed with the year when it matters", () => {
  it("adds the year when the log runs over more than one year", () => {
    // two readings a year apart
    const apart = of([E("2025-09-03", "A", { bodOutlet: 70 }), E("2026-09-03", "A", { bodOutlet: 60 })], "limit");
    expect(apart.map((f) => f.detail)).toEqual([
      "Outlet BOD read 70 mg/L on 3 Sep 2025, shift A, against a limit of max 30 mg/L.",
      "Outlet BOD read 60 mg/L on 3 Sep 2026, shift A, against a limit of max 30 mg/L.",
    ]);
    // a log that runs across the new year
    const across = series(9, (i) => ({ tssOutlet: i === 1 || i === 7 ? 150 : 30 })).map((e) => ({ ...e, date: addDays(e.date, 120) }));
    expect(of(across, "limit").map((f) => f.detail.match(/on ([^,]+),/)![1])).toEqual(["30 Dec 2026", "1 Jan 2027"]);
    // and one that covers more than ten months of a single year
    const long = [E("2026-01-05", "A", { tssOutlet: 150 }), ...[40, 90, 140, 190, 240, 290].map((d) => E(addDays("2026-01-05", d), "A", { tssOutlet: 30 })), E("2026-12-20", "A", {})];
    expect(of(long, "limit")[0].detail).toContain("on 5 Jan 2026,");
  });
  it("adds the year for an old register digitised in a later year, and not for a current one", () => {
    const old = daily(16, (i) => ({ tssOutlet: i === 2 ? 140 : 30 }), () => ({ pageId: "pg1", capturedAt: "2026-10-04T10:00:00.000Z" })).map((e) => ({
      ...e,
      date: e.date.replace("2026", "2021"),
    }));
    const flags = runChecks(dailyPlant, old).flags;
    const back = flags.find((f) => f.ruleId === "backfill")!;
    expect(back.detail).toContain("16 entries for 1 Sep 2021 to 16 Sep 2021 were digitised on 4 Oct 2026");
    expect(flags.find((f) => f.ruleId === "limit")!.detail).toContain("on 3 Sep 2021");
    const now = daily(16, (i) => ({ tssOutlet: i === 2 ? 140 : 30 }));
    expect(of(now, "limit", dailyPlant)[0].detail).toContain("on 3 Sep,");
  });
  it("adds the year to one stray entry without changing the rest", () => {
    const es = [...series(30, (i) => ({ tssOutlet: i === 4 ? 150 : 30 })), E("2062-09-05", "A", { tssOutlet: 180 })];
    const lim = of(es, "limit");
    expect(lim.map((f) => f.detail.match(/on ([^,]+),/)![1])).toEqual(["2 Sep", "5 Sep 2062"]);
  });
});

describe("physical: figures out of scale", () => {
  const doses = (lime: (i: number) => number, n = 20) =>
    daily(n, (i) => ({ limeKg: lime(i), alumKg: 1, chlorineKg: 0.05, sludgeKg: 2, runHours: 6 }));
  it("questions one dose a thousand times the usual one", () => {
    const es = doses((i) => (i === 9 ? 500 : 0.5));
    const f = of(es, "physical", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("physical:capacity:limeKg");
    expect(f[0].severity).toBe("medium");
    expect(f[0].entryIds).toEqual([es[9].id]);
    expect(f[0].detail).toContain("Lime dosed is 500.00 kg on 10 Sep");
    expect(f[0].detail).toContain("design capacity in the plant settings is 10 KLD");
    expect(f[0].detail).toContain("50 kg for every m³");
    expect(f[0].verify).toContain("grams written in the kilogram column");
  });
  it("questions a whole page of them in one flag for each column", () => {
    const es = daily(20, () => ({ limeKg: 500, alumKg: 1000, chlorineKg: 50, sludgeKg: 2 }));
    const f = of(es, "physical", dailyPlant);
    expect(f.map((x) => x.id).sort()).toEqual(["physical:capacity:alumKg", "physical:capacity:chlorineKg", "physical:capacity:limeKg"]);
    for (const x of f) expect(x.entryIds).toHaveLength(20);
    expect(f.find((x) => x.param === "limeKg")!.detail).toContain("and too large in the same way on 19 other entries");
  });
  it("still questions the odd one out when the capacity is not known", () => {
    for (const cap of [0, -5, Number.NaN, undefined, null, "big"]) {
      const p = { ...dailyPlant, capacityKld: cap } as unknown as Plant;
      const es = doses((i) => (i === 9 ? 500 : 0.5));
      es[4].values.sludgeKg = 2000;
      const f = of(es, "physical", p);
      expect(f.map((x) => x.id).sort(), String(cap)).toEqual(["physical:scale:limeKg:above", "physical:scale:sludgeKg:above"]);
      expect(f.find((x) => x.param === "limeKg")!.detail).toBe("Lime dosed is 500.00 kg on 10 Sep; the other 19 entries are around 0.50 kg.");
      expect(f[0].severity).toBe("medium");
    }
    // and a dose written a thousand times too small
    const low = of(doses((i) => (i === 9 ? 0.0005 : 0.5)), "physical", dailyPlant);
    expect(low.map((x) => x.id)).toEqual(["physical:scale:limeKg:below"]);
    // ordinary variation, zero doses and short columns are left alone
    expect(of(doses((i) => [0.5, 1, 2, 0, 5][i % 5]), "physical", dailyPlant)).toHaveLength(0);
    expect(of(doses((i) => (i === 3 ? 500 : 0.5), 5), "physical", { ...dailyPlant, capacityKld: 0 })).toHaveLength(0);
  });
  it("questions a shift flow with an extra digit", () => {
    const flow = (i: number) => [97, 83, 51][i % 3] + (i % 4);
    const es = series(30, (i) => ({ inletFlow: i === 13 ? 503 : flow(i), outletFlow: i === 13 ? 480 : flow(i) - 4 }));
    const f = of(es, "physical");
    expect(f.map((x) => x.id).sort()).toEqual(["physical:capacity:inletFlow", "physical:capacity:outletFlow"]);
    for (const x of f) {
      expect(x.severity).toBe("high");
      expect(x.entryIds).toEqual([es[13].id]);
    }
    expect(f.find((x) => x.param === "inletFlow")!.detail).toContain("503 m³ in one entry on 5 Sep, shift B");
    // with no capacity to go by, it is still far from the column's usual figure
    const g = of(es, "physical", { ...plant, capacityKld: 0 });
    expect(g.map((x) => x.id).sort()).toEqual(["physical:scale:inletFlow:above", "physical:scale:outletFlow:above"]);
    expect(g[0].severity).toBe("medium");
  });
  it("questions a day's volume far above the design capacity, once", () => {
    const es = series(18, (i) => ({ inletFlow: i === 4 ? 9800 : 80 + (i % 5), outletFlow: 75 + (i % 4) }));
    const f = of(es, "physical");
    expect(f.map((x) => x.id)).toEqual(["physical:capacity:inletFlow"]);
    expect(f[0].severity).toBe("high");
    expect(f[0].title).toBe("Inlet flow far above the plant's capacity");
    expect(f[0].detail).toMatch(/99\d\d m³ on 2 Sep/);
    expect(f[0].detail).toContain("250 KLD");
    expect(f[0].verify).toContain("slipped digit");
    expect(f[0].entryIds).toHaveLength(3);
    // a plant whose capacity setting is simply wrong gets one flag, not one a day
    const all = of(series(30, (i) => ({ inletFlow: 900 + i })), "physical");
    expect(all).toHaveLength(1);
    expect(all[0].entryIds).toHaveLength(30);
    expect(all[0].verify).toContain("check the design capacity in the plant settings");
  });
  it("questions a flow meter that rises faster than the plant can treat", () => {
    // the last reading, 18372, written as 183720: no later row to show it up
    const es = daily(30, (i) => ({ inletTotaliser: i === 29 ? 183720 : 18140 + i * 8 + ((i * 5) % 3) }));
    const f = runChecks(dailyPlant, es).flags;
    expect(f.map((x) => x.id)).toEqual(["physical:capacity:inletTotaliser"]);
    expect(f[0].severity).toBe("high");
    expect(f[0].entryIds).toEqual([es[29].id]);
    expect(f[0].detail).toMatch(/a rise of 1653\d\d m³ to 183720 on 30 Sep/);
    expect(f[0].detail).toContain("10 KLD");
    // the same slip on a meter that has no capacity to compare with
    const en = daily(30, (i) => ({ energyKwh: i === 29 ? 912440 : 90900 + i * 11 + (i % 3) }));
    const g = of(en, "physical", dailyPlant);
    expect(g.map((x) => x.id)).toEqual(["physical:jump:energyKwh"]);
    expect(g[0].severity).toBe("medium");
    expect(g[0].entryIds).toEqual([en[29].id]);
    // a misread row that the next row corrects is the meter rule's finding alone
    const dip = daily(12, (i) => ({ energyKwh: i === 5 ? 120 : 5000 + i * 11 + (i % 3) }));
    expect(of(dip, "physical", dailyPlant)).toHaveLength(0);
    expect(of(dip, "meter", dailyPlant)).toHaveLength(1);
    // and a new meter with a higher reading, noted in the remarks, is not a jump
    const swap = daily(12, (i) => ({ energyKwh: i < 6 ? 5000 + i * 11 + (i % 3) : 80000 + i * 11 + (i % 3) }), (i) => ({ remarks: i === 6 ? "new energy meter fitted" : null }));
    expect(of(swap, "physical", dailyPlant)).toHaveLength(0);
  });
  it("questions inlet flow several times the outlet flow, in one flag", () => {
    const es = series(12, (i) => ({ inletFlow: 80 + (i % 5), outletFlow: i >= 3 && i < 6 ? 20 : 75 + (i % 4) }));
    const f = of(es, "physical");
    expect(f.map((x) => x.id)).toEqual(["physical:flow-gross"]);
    expect(f[0].severity).toBe("medium");
    expect(f[0].entryIds).toHaveLength(3);
    expect(f[0].detail).toMatch(/24\d m³ in against 60 m³ out on 2 Sep/);
    // twice the outlet is not gross
    expect(of(series(12, (i) => ({ inletFlow: 80 + (i % 5), outletFlow: 40 })), "physical")).toHaveLength(0);
  });
  it("asks about blower hours over 24 on a day's row instead of calling them impossible", () => {
    const two = of(daily(1, () => ({ blowerHours: 28 })), "physical", dailyPlant);
    expect(two).toHaveLength(1);
    expect(two[0].severity).toBe("medium");
    expect(two[0].title).toBe("Blower hours longer than the day");
    expect(two[0].detail).toContain("more than the 24 hours in a day");
    expect(two[0].verify).toContain("more than one blower");
    expect(text(two[0])).not.toMatch(/shift|decimal point/i);
    expect(of(daily(1, () => ({ blowerHours: 24 })), "physical", dailyPlant)).toHaveLength(0);
    const many = of(daily(1, () => ({ blowerHours: 120 })), "physical", dailyPlant);
    expect(many).toHaveLength(1);
    expect(many[0].severity).toBe("high");
    // a row with no shift letter and no time at a three-shift plant is a day's row
    expect(of([E("2026-09-01", null, { blowerHours: 20 })], "physical")).toHaveLength(0);
    const day = of([E("2026-09-01", null, { blowerHours: 30 })], "physical");
    expect(day).toHaveLength(1);
    expect(day[0].detail).toContain("more than the 24 hours in a day");
    // with a clock time it is one shift's reading
    expect(of([E("2026-09-01", null, { blowerHours: 20 }, { time: "09:00" })], "physical")[0].detail).toContain("8 h in a shift");
  });
});

describe("meter: details", () => {
  it("does not take a remark that the meter was NOT changed as a meter change", () => {
    for (const remark of ["meter not changed", "Energy meter unchanged since morning", "no new meter yet", "meter nahi badla", "meter change not done", "meter wasn't replaced"]) {
      const es = daily(4, (i) => ({ energyKwh: [1000, 1012, 950, 962][i] }), (i) => ({ remarks: i === 2 ? remark : null }));
      const f = of(es, "meter", dailyPlant);
      expect(f, remark).toHaveLength(1);
      expect(f[0].id, remark).toBe(`meter:down:energyKwh:${es[2].id}`);
      expect(f[0].severity, remark).toBe("high");
    }
    // a negation in another clause does not undo a real note
    for (const remark of ["old meter not working, new meter fitted", "meter changed, no other work", "Light nahi thi. Meter badla"]) {
      const es = daily(4, (i) => ({ energyKwh: [1000, 1012, 950, 962][i] }), (i) => ({ remarks: i === 2 ? remark : null }));
      expect(of(es, "meter", dailyPlant)[0].severity, remark).toBe("low");
    }
  });
  it("mentions a wrong date among the reasons a meter can seem to go down", () => {
    const f = of(daily(3, (i) => ({ energyKwh: [1000, 1100, 1050][i] })), "meter", dailyPlant);
    expect(f[0].verify).toContain("an entry saved under the wrong date");
  });
  it("reports a meter that moves about one unit per entry once, as a note", () => {
    // whole units written down while the plant uses about 0.4 of a unit a day
    const es = daily(20, (i) => ({ energyKwh: 500 + Math.floor(i * 0.4), runHours: 6 }));
    const f = of(es, "meter", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("meter:stall:energyKwh:coarse");
    expect(f[0].severity).toBe("low");
    expect(f[0].title).toBe("Energy meter moves about one unit per entry");
    expect(f[0].entryIds).toHaveLength(12);
    expect(f[0].verify).toContain("multiplier");
  });
  it("sums up a meter that stands still again and again in one flag", () => {
    // read every third day and carried forward in between
    const es = daily(15, (i) => ({ energyKwh: 5000 + Math.floor(i / 3) * 33 + (Math.floor(i / 3) % 2), runHours: 6 }));
    const f = of(es, "meter", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("meter:stall:energyKwh:many");
    expect(f[0].severity).toBe("medium");
    expect(f[0].detail).toContain("on 5 separate occasions (10 entries in all)");
    expect(f[0].entryIds).toHaveLength(10);
  });
});

describe("ahead", () => {
  const page = (dates: string[], capturedAt: string, pageId: string | null = "pg1") =>
    dates.flatMap((d) => SH.map((s) => E(d, s, { phOutlet: 7.2 }, { pageId, capturedAt })));
  it("flags rows dated after the day their page was photographed", () => {
    // photographed on 4 Oct at 16:47 Indian time
    const es = page(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"], "2026-10-04T11:17:00.000Z");
    const f = of(es, "ahead");
    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("ahead:2026-10-04");
    expect(f[0].severity).toBe("medium");
    expect(f[0].category).toBe("integrity");
    expect(f[0].entryIds).toEqual(es.filter((e) => e.date === "2026-10-05").map((e) => e.id));
    expect(f[0].detail).toBe("3 entries from 5 Oct, shift A to 5 Oct, shift C were digitised on 4 Oct, before the dates they carry.");
    expect(f[0].verify).toContain("written before the shift, or whether the date was misread");
    expect(text(f[0])).not.toMatch(/fraud|fake|fabricat|cheat/i);
  });
  it("makes one flag per day of photographing, and covers typed entries and daily rows", () => {
    const es = [
      ...page(["2026-10-05"], "2026-10-04T11:17:00.000Z"),
      ...page(["2026-10-07"], "2026-10-06T05:00:00.000Z", null).map((e) => ({ ...e, id: `${e.id}-typed` })),
    ];
    expect(of(es, "ahead").map((f) => f.id)).toEqual(["ahead:2026-10-04", "ahead:2026-10-06"]);
    const day = daily(3, () => ({ runHours: 6 }), () => ({ pageId: "pg1", capturedAt: "2026-09-02T05:00:00.000Z" }));
    const f = of(day, "ahead", dailyPlant);
    expect(f).toHaveLength(1);
    expect(f[0].entryIds).toEqual([day[2].id]);
    expect(f[0].detail).toBe("1 entry on 3 Sep was digitised on 2 Sep, before the date it carries.");
    expect(text(f[0])).not.toMatch(/shift/i);
  });
  it("uses the Indian day, and allows a night shift dated by the morning it ends", () => {
    // 3 Sep 23:30 UTC is already 4 Sep in India
    expect(of(page(["2026-09-04"], "2026-09-03T23:30:00.000Z"), "ahead")).toHaveLength(0);
    // photographed at 23:00 on the 3rd: tomorrow's A and B rows are ahead, its night shift row is not
    const es = page(["2026-09-04"], "2026-09-03T17:30:00.000Z");
    const f = of(es, "ahead");
    expect(f).toHaveLength(1);
    expect(f[0].entryIds).toEqual([es[0].id, es[1].id]);
  });
  it("ignores the bundled sample data, timely entries and unreadable capture times", () => {
    expect(of(page(["2026-10-05"], "2026-10-04T11:17:00.000Z", "seed"), "ahead")).toHaveLength(0);
    expect(of(page(["2026-10-04"], "2026-10-04T11:17:00.000Z"), "ahead")).toHaveLength(0);
    expect(of(page(["2026-10-05"], "not a time"), "ahead")).toHaveLength(0);
    expect(of(page(["2026-10-05"], undefined as unknown as string), "ahead")).toHaveLength(0);
  });
});

describe("wording about people", () => {
  const lab = (i: number) => ({
    phInlet: 6.8 + ((i * 7) % 11) / 10,
    phOutlet: 7 + ((i * 3) % 9) / 10,
    doAeration: 1.5 + ((i * 5) % 17) / 10,
    residualChlorine: 0.3 + ((i * 3) % 7) / 10,
  });
  it("does not put an operator's name beside copied or repeated readings", () => {
    const es = series(30, (i) => ({ ...lab(i >= 10 && i <= 14 ? 9 : i), inletFlow: distinct(i) }), () => ({ operator: "Mahesh" }));
    const flags = runChecks(plant, es).flags.filter((f) => f.ruleId === "rowcopy" || f.ruleId === "repeat");
    expect(flags.map((f) => f.ruleId).sort()).toEqual(["repeat", "rowcopy"]);
    for (const f of flags) {
      expect(text(f)).not.toMatch(/mahesh|operator/i);
      expect(text(f)).not.toMatch(/sampled and tested|how the page was filled/i);
    }
    // the rowcopy flag starts from the instruments
    expect(flags.find((f) => f.ruleId === "rowcopy")!.verify).toMatch(/^A probe left reading the same spot/);
  });
  it("says how many entries a repeat flag links when that is more than the shared stretch", () => {
    const es = series(45, (i) => ({
      inletFlow: i >= 20 && i < 27 ? 77 : distinct(i),
      mlss: i >= 18 && i < 28 ? 3000 : 2500 + distinct(i) * 10,
    }));
    const f = of(es, "repeat");
    expect(f).toHaveLength(1);
    expect(f[0].entryIds).toHaveLength(10);
    expect(f[0].detail).toContain("over 7 entries in a row");
    expect(f[0].detail).toContain("At least one of them repeats for longer, so 10 entries are linked here (7 Sep, shift A to 10 Sep, shift A).");
    // nothing is added when the two agree
    const same = series(45, (i) => ({ inletFlow: i >= 20 && i < 27 ? 77 : distinct(i), mlss: i >= 20 && i < 27 ? 3000 : 2500 + distinct(i) * 10 }));
    expect(of(same, "repeat")[0].detail).not.toContain("linked here");
  });
});

describe("large logs", () => {
  it("runs 10,000 entries of coarse, run-filled columns in about a second at most", () => {
    const rnd = mulberry32(21);
    let energy = 0;
    const es = Array.from({ length: 10000 }, (_, i) => {
      const s = slot(i);
      energy += 60 + Math.floor(rnd() * 30);
      return E(
        s.date,
        s.shift,
        {
          phInlet: rnd() < 0.85 ? 7 : 8,
          phOutlet: rnd() < 0.85 ? 7 : 6,
          residualChlorine: rnd() < 0.8 ? 0.5 : 0.2,
          doAeration: Math.round((2 + rnd()) * 2) / 2,
          inletFlow: 60 + Math.floor(rnd() * 4) * 5,
          energyKwh: energy,
          blowerHours: 6,
        },
        { operator: ["Asha", "Ravi", "Imran"][Math.floor(i / 21) % 3] },
      );
    });
    runChecks(plant, es.slice(0, 300)); // warm up
    const t = performance.now();
    const r = runChecks(plant, es);
    const ms = performance.now() - t;
    expect(ms, `${ms} ms`).toBeLessThan(1200);
    expect(r.expectedShifts).toBe(10000);
  });
  it("is not slowed to a crawl by one operator and columns made of short runs", () => {
    let energy = 0;
    const es = Array.from({ length: 20000 }, (_, i) => {
      const s = slot(i);
      energy += 50 + (Math.floor(i / 6) % 3);
      const block = Math.floor(i / 5);
      return E(s.date, s.shift, { phInlet: 7 + (block % 2), phOutlet: 7 + (Math.floor(i / 7) % 2), doAeration: 2 + (Math.floor(i / 4) % 3) / 2, energyKwh: energy, blowerHours: 6 }, { operator: "Asha" });
    });
    const t = performance.now();
    runChecks(plant, es);
    const ms = performance.now() - t;
    expect(ms, `${ms} ms`).toBeLessThan(3000);
  });
  it("is not slowed by thousands of rows that share one date and shift", () => {
    const es = Array.from({ length: 5000 }, (_, i) => E("2026-09-01", "A", { inletFlow: i }));
    const t = performance.now();
    runChecks(plant, es);
    const ms = performance.now() - t;
    expect(ms, `${ms} ms`).toBeLessThan(2000);
  });
});

describe("flag contract", () => {
  const es = series(30, (i) => ({
    phOutlet: i === 10 ? 71 : spread(i),
    inletFlow: i < 6 ? 80 : distinct(i),
    tssOutlet: i === 20 ? 130 : 30,
    bodOutlet: 12,
    energyKwh: 1000 + i * 40,
    blowerHours: 6,
  })).filter((_, i) => i !== 14);
  it("has stable ids across runs", () => {
    const a = runChecks(plant, es).flags.map((f) => f.id);
    const b = runChecks(plant, [...es].reverse()).flags.map((f) => f.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
  it("sorts high before medium before low, then by date", () => {
    const flags = runChecks(plant, es).flags;
    const rank = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < flags.length; i++) {
      const a = flags[i - 1];
      const b = flags[i];
      expect(rank[a.severity]).toBeLessThanOrEqual(rank[b.severity]);
      if (a.severity === b.severity) expect((a.date ?? "9") <= (b.date ?? "9")).toBe(true);
    }
  });
  it("gives every flag a detail, a verify line and no accusatory wording", () => {
    const flags = runChecks(plant, es).flags;
    expect(flags.length).toBeGreaterThan(3);
    for (const f of flags) {
      expect(f.detail.length).toBeGreaterThan(10);
      expect(f.verify.length).toBeGreaterThan(10);
      expect(text(f)).not.toMatch(/fraud|fake|fabricat|cheat|lying|dishonest|tamper/i);
      expect(text(f)).not.toMatch(/undefined|NaN/);
      expect(RULES.some((r) => r.id === f.ruleId && r.category === f.category)).toBe(true);
    }
  });
  it("exports the rule list with unique ids and clean wording", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect(`${r.title} ${r.description}`).not.toMatch(/fraud|fake|fabricat|cheat/i);
      expect(r.description.length).toBeGreaterThan(40);
    }
    expect(RULES.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "limit", "physical", "repeat", "rowcopy", "digits", "flat", "missing", "date", "duplicate",
        "bodfreq", "meter", "step", "twin", "flowgap", "svi", "hugging", "backfill", "ahead",
      ]),
    );
  });
});
