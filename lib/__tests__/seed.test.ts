import { describe, expect, it } from "vitest";
import { runChecks } from "../checks";
import { DEFAULT_LIMITS, SHIFTS } from "../params";
import { buildDailySeed, buildSeed } from "../seed";
import type { Planted } from "../seed";
import type { Flag, LogEntry } from "../types";

const END = "2026-09-27";
const DAILY_END = "2026-09-20";

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// A flag is explained by a planted problem when it is the planted rule and
// points at the planted entries (or, for an absence, at nothing).
function explains(p: Planted, f: Flag): boolean {
  if (f.ruleId !== p.ruleId) return false;
  if (!p.entryIds.length) return f.entryIds.length === 0;
  return p.entryIds.some((id) => f.entryIds.includes(id));
}

// The flag that reports a planted problem: right rule, and every planted entry in it.
function flagFor(p: Planted, flags: Flag[]): Flag | undefined {
  return flags.find((f) => f.ruleId === p.ruleId && (p.entryIds.length ? p.entryIds.every((id) => f.entryIds.includes(id)) : f.entryIds.length === 0));
}

describe("buildSeed (three-shift lab-style log)", () => {
  it("is deterministic for a given end date and differs between dates", () => {
    expect(buildSeed(END)).toEqual(buildSeed(END));
    expect(buildSeed("2026-10-04").entries[0].values).not.toEqual(buildSeed(END).entries[0].values);
  });

  it("builds the documented plant and 30 days of seed entries", () => {
    const { plant, entries } = buildSeed(END);
    expect(plant.id).toBe("demo-plant");
    expect(plant.name).toBe("Aravali Residency STP");
    expect(plant.shiftsPerDay).toBe(3);
    // the log is run on MLSS and SV30, which a pure MBBR is not
    expect(plant.technology).not.toBe("MBBR");
    expect(plant.limits).toEqual(DEFAULT_LIMITS.STP);
    expect(plant.limits).not.toBe(DEFAULT_LIMITS.STP); // a copy the user can edit
    expect(entries).toHaveLength(88); // 90 slots minus 2 planted gaps
    const dates = entries.map((e) => e.date).sort();
    expect(dates[0]).toBe("2026-08-29");
    expect(dates[dates.length - 1]).toBe(END);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    for (const e of entries) {
      expect(e.pageId).toBe("seed");
      expect(e.plantId).toBe("demo-plant");
      expect(e.id).toBe(`seed-${e.date}-${e.shift}`);
      expect(e.time).toBe(SHIFTS[e.shift!].start);
    }
  });

  it("stamps each entry after its own shift has ended", () => {
    for (const e of buildSeed(END).entries) {
      // shift end in Indian time, as a UTC instant
      const endHour = { A: 14, B: 22, C: 30 }[e.shift!];
      const shiftEnd = Date.parse(`${e.date}T00:00:00.000Z`) + (endHour - 5.5) * 3600000;
      const captured = Date.parse(e.capturedAt);
      expect(captured, e.id).toBeGreaterThan(shiftEnd);
      expect(captured - shiftEnd, e.id).toBeLessThan(3600000);
    }
  });

  it("uses the agreed operator names on a roster a person could work", () => {
    const { entries } = buildSeed(END);
    expect([...new Set(entries.map((e) => e.operator))].sort()).toEqual(["Mahesh", "Ramesh", "Suresh"]);
    const byDate = new Map<string, LogEntry[]>();
    for (const e of entries) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
    for (const [date, es] of byDate) {
      // one shift each per day
      expect(new Set(es.map((e) => e.operator)).size, date).toBe(es.length);
      // and the night operator is not back on at 06:00 the next morning
      const night = es.find((e) => e.shift === "C");
      const nextMorning = (byDate.get(addDays(date, 1)) ?? []).find((e) => e.shift === "A");
      if (night && nextMorning) expect(nextMorning.operator, date).not.toBe(night.operator);
    }
    // the last week matches the sample logbook pages that continue from here
    for (const e of entries.filter((x) => x.date >= "2026-09-21")) {
      expect(e.operator, e.id).toBe({ A: "Ramesh", B: "Suresh", C: "Mahesh" }[e.shift!]);
    }
  });

  it("ends the energy meter at exactly 48220 kWh on the last entry", () => {
    for (const end of [END, "2026-10-04", "2027-01-31"]) {
      const { entries } = buildSeed(end);
      expect(entries[entries.length - 1].id).toBe(`seed-${end}-C`);
      expect(entries[entries.length - 1].values.energyKwh).toBe(48220);
    }
  });

  it("records each parameter as often as a plant this size would", () => {
    const { entries } = buildSeed(END);
    for (const e of entries) {
      for (const k of ["inletFlow", "outletFlow", "phInlet", "phOutlet", "doAeration", "residualChlorine", "blowerHours", "energyKwh"] as const) {
        expect(typeof e.values[k], `${e.id} ${k}`).toBe("number");
      }
    }
    const mlss = entries.filter((e) => e.values.mlss != null);
    const cod = entries.filter((e) => e.values.codOutlet != null);
    // once a day on the morning shift, plus the three extra shifts tested during the upset
    expect(mlss.filter((e) => e.shift !== "A")).toHaveLength(3);
    expect(mlss.length).toBeGreaterThanOrEqual(30);
    expect(mlss.length).toBeLessThanOrEqual(33);
    // a few times a week, not every shift
    expect(cod.length).toBeGreaterThanOrEqual(12);
    expect(cod.length).toBeLessThanOrEqual(18);
    expect(entries.filter((e) => e.values.tssOutlet != null)).toHaveLength(cod.length);
  });

  it("does not tie the outlet flow to a fixed share of the inlet", () => {
    const { entries } = buildSeed(END);
    const ratios = entries.map((e) => (e.values.outletFlow as number) / (e.values.inletFlow as number));
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.1);
    // while a whole day's outlet stays below its inlet
    const days = new Map<string, { i: number; o: number }>();
    for (const e of entries) {
      const d = days.get(e.date) ?? { i: 0, o: 0 };
      d.i += e.values.inletFlow as number;
      d.o += e.values.outletFlow as number;
      days.set(e.date, d);
    }
    for (const [date, d] of days) expect(d.o / d.i, date).toBeLessThan(1.05);
  });

  it("lets the blower hours and energy fall while a blower is tripped", () => {
    const { entries } = buildSeed(END);
    const i = entries.findIndex((e) => (e.remarks ?? "").includes("Blower 2 tripped"));
    expect(i).toBeGreaterThan(0);
    const rise = (j: number) => (entries[j].values.energyKwh as number) - (entries[j - 1].values.energyKwh as number);
    const usual = entries.map((e) => e.values.blowerHours as number).sort((a, b) => a - b)[Math.floor(entries.length / 2)];
    for (const j of [i, i + 1]) {
      expect(entries[j].values.blowerHours as number, entries[j].id).toBeLessThanOrEqual(usual - 2);
      expect(rise(j), entries[j].id).toBeLessThan(60);
    }
    expect(entries[i + 2].remarks).toContain("restarted");
    expect(entries[i + 2].values.blowerHours as number).toBeGreaterThanOrEqual(5);
  });

  it("keeps the last three days clean and close to the next page", () => {
    const { plant, entries } = buildSeed(END);
    const tail = entries.filter((e) => e.date >= "2026-09-25");
    expect(tail).toHaveLength(9);
    const tailIds = new Set(tail.map((e) => e.id));
    const r = runChecks(plant, entries);
    for (const f of r.flags) {
      if (f.ruleId === "digits") continue; // covers every reading under one operator name
      expect(f.entryIds.some((id) => tailIds.has(id)), f.id).toBe(false);
    }
    const morning = entries.find((e) => e.id === `seed-${END}-A`)!;
    expect(morning.values.mlss as number).toBeGreaterThanOrEqual(3100);
    expect(morning.values.mlss as number).toBeLessThanOrEqual(3200);
    expect(morning.values.sv30 as number).toBeGreaterThanOrEqual(400);
    expect(morning.values.sv30 as number).toBeLessThanOrEqual(445);
  });

  it("flags every planted problem at the entries it was planted in", () => {
    const { plant, entries, planted } = buildSeed(END);
    const r = runChecks(plant, entries);
    expect(planted.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(entries.map((e) => e.id));
    for (const p of planted) {
      for (const id of p.entryIds) expect(ids.has(id), `${p.ruleId}: ${id}`).toBe(true);
      expect(flagFor(p, r.flags), `${p.ruleId}: ${p.note}`).toBeDefined();
    }
    // the two gaps are the two planted ones
    expect(r.flags.filter((f) => f.ruleId === "missing").map((f) => f.date).sort()).toEqual(["2026-09-03", "2026-09-24"]);
    // the copied night shifts are one high repeat flag and one high rowcopy flag
    const repeat = flagFor(planted.find((p) => p.ruleId === "repeat")!, r.flags)!;
    expect(repeat.severity).toBe("high");
    expect(repeat.detail).toContain("7 shift C entries in a row");
    const rowcopy = flagFor(planted.find((p) => p.ruleId === "rowcopy")!, r.flags)!;
    expect(rowcopy.entryIds).toHaveLength(6);
    // the rounding habit is reported against the readings of the other operators
    const digits = r.flags.filter((f) => f.ruleId === "digits");
    expect(digits.map((f) => f.param).sort()).toEqual(["doAeration", "residualChlorine"]);
    for (const f of digits) expect(f.detail).toMatch(/Among the other \d+ readings the share is \d+%/);
  });

  it("raises nothing on the demo date that was not planted", () => {
    const { plant, entries, planted } = buildSeed(END);
    const flags = runChecks(plant, entries).flags;
    for (const f of flags) expect(planted.some((p) => explains(p, f)), `${f.severity} ${f.id}: ${f.detail}`).toBe(true);
    expect(flags.filter((f) => f.severity === "high").map((f) => f.ruleId).sort()).toEqual(["limit", "limit", "meter", "physical", "repeat", "rowcopy"]);
  });

  it("stays honest on other end dates: planted problems found, hardly anything else", () => {
    // Nothing in the generated data is tidied up after the fact, so this is the
    // engine's real false-positive rate on 60 different random months.
    let unplanted = 0;
    const seen: string[] = [];
    for (let i = 0; i < 60; i++) {
      const end = addDays("2026-01-05", i * 11);
      const { plant, entries, planted } = buildSeed(end);
      const flags = runChecks(plant, entries).flags;
      for (const p of planted) expect(flagFor(p, flags), `${end} ${p.ruleId}: ${p.note}`).toBeDefined();
      for (const f of flags) {
        if (planted.some((p) => explains(p, f))) continue;
        unplanted++;
        seen.push(`${end} ${f.severity} ${f.id}`);
        expect(f.severity, `${end} ${f.id}: ${f.detail}`).not.toBe("high");
      }
    }
    expect(unplanted, seen.join("\n")).toBeLessThanOrEqual(0);
  });

  it("drops the shift wording when the plant is set to one entry a day", () => {
    const { plant, entries } = buildSeed(END);
    const r = runChecks({ ...plant, shiftsPerDay: 1 }, entries);
    for (const f of r.flags) expect(`${f.title} ${f.detail} ${f.verify}`, f.id).not.toMatch(/shift/i);
    // three rows a day at a one-entry-a-day plant is said once
    const over = r.flags.filter((f) => f.id === "missing:over");
    expect(over).toHaveLength(1);
    expect(over[0].detail).toContain("30 of the 30 days in the log have more than 1 entry (up to 3 a day)");
    expect(r.flags.filter((f) => f.ruleId === "duplicate")).toHaveLength(0);
    expect([r.recordedShifts, r.expectedShifts]).toEqual([30, 30]);
  });

  it("links the repeat flag to the same entries its sentence counts", () => {
    const { plant, entries, planted } = buildSeed(END);
    const repeat = flagFor(planted.find((p) => p.ruleId === "repeat")!, runChecks(plant, entries).flags)!;
    const counted = Number(repeat.detail.match(/over (\d+) shift C entries in a row/)![1]);
    if (repeat.entryIds.length === counted) expect(repeat.detail).not.toContain("linked here");
    else expect(repeat.detail).toContain(`so ${repeat.entryIds.length} entries are linked here`);
  });

  it("keeps operator names out of flag titles and out of the copied-row flags", () => {
    const { plant, entries } = buildSeed(END);
    for (const f of runChecks(plant, entries).flags) {
      expect(f.title, f.id).not.toMatch(/ramesh|suresh|mahesh/i);
      if (f.ruleId === "rowcopy" || f.ruleId === "repeat") expect(`${f.detail} ${f.verify}`, f.id).not.toMatch(/ramesh|suresh|mahesh|operator/i);
    }
  });

  it("reports sensible shift counts and compliance", () => {
    const { plant, entries } = buildSeed(END);
    const r = runChecks(plant, entries);
    expect(r.expectedShifts).toBe(90);
    expect(r.recordedShifts).toBe(88);
    expect(r.complianceRate).toBeGreaterThan(0.9);
    expect(r.complianceRate).toBeLessThan(1);
  });

  it("does not crash on a malformed end date", () => {
    for (const bad of ["", "garbage", "2026-13-40", undefined as unknown as string]) {
      const { entries } = buildSeed(bad);
      expect(entries).toHaveLength(88);
      for (const e of entries) expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("runs the checks on the seed in under 50 ms", () => {
    const { plant, entries } = buildSeed(END);
    runChecks(plant, entries); // warm up
    const t = performance.now();
    runChecks(plant, entries);
    expect(performance.now() - t).toBeLessThan(50);
  });
});

describe("buildDailySeed (one-row-a-day meter-and-dosing register)", () => {
  it("is deterministic for a given end date and differs between dates", () => {
    expect(buildDailySeed(DAILY_END)).toEqual(buildDailySeed(DAILY_END));
    const a = buildDailySeed(DAILY_END).entries.map((e) => e.values.inletTotaliser);
    const b = buildDailySeed("2026-10-04").entries.map((e) => e.values.inletTotaliser);
    expect(a).not.toEqual(b);
  });

  it("builds the documented plant", () => {
    const { plant } = buildDailySeed(DAILY_END);
    expect(plant).toEqual({
      id: "demo-daily",
      name: "Sample Clinic STP",
      kind: "STP",
      location: "Malviya Nagar, Jaipur",
      capacityKld: 10,
      technology: "MBBR",
      operatorCompany: "In-house maintenance",
      consentNo: "sample",
      shiftsPerDay: 1,
      limits: DEFAULT_LIMITS.STP,
    });
    expect(plant.limits).not.toBe(DEFAULT_LIMITS.STP);
  });

  it("builds 45 daily rows ending on the end date, with no shift and no time", () => {
    const { entries } = buildDailySeed(DAILY_END);
    expect(entries).toHaveLength(45);
    expect(entries[entries.length - 1].date).toBe(DAILY_END);
    expect(new Set(entries.map((e) => e.id)).size).toBe(45);
    expect(new Set(entries.map((e) => e.date)).size).toBe(45);
    for (let i = 1; i < entries.length; i++) expect(entries[i].date > entries[i - 1].date).toBe(true);
    for (const e of entries) {
      expect(e.shift).toBeNull();
      expect(e.time).toBeNull();
      expect(e.operator).toBe("Sunil");
      expect(e.pageId).toBe("seed");
      expect(e.plantId).toBe("demo-daily");
      expect(Date.parse(e.capturedAt)).toBeGreaterThan(Date.parse(`${e.date}T00:00:00.000Z`));
      // a meter-and-dosing register has no lab columns
      for (const k of ["phOutlet", "codOutlet", "bodOutlet", "tssOutlet", "mlss", "doAeration", "inletFlow"] as const) {
        expect(e.values[k]).toBeUndefined();
      }
    }
  });

  it("pins the final readings the sample page continues from, for any end date", () => {
    for (const end of [DAILY_END, "2026-10-04", "2027-02-28"]) {
      const { entries } = buildDailySeed(end);
      const last = entries[entries.length - 1];
      expect(last.date).toBe(end);
      expect(last.values.inletTotaliser).toBe(18460);
      expect(last.values.outletTotaliser).toBe(17105);
      expect(last.values.energyKwh).toBe(91244);
    }
  });

  it("looks like a small plant's register", () => {
    const { entries } = buildDailySeed(DAILY_END);
    const days = (i: number) => (Date.parse(entries[i].date) - Date.parse(entries[i - 1].date)) / 86400000;
    // 6 to 10 m³ a day through the inlet meter
    for (let i = 1; i < entries.length; i++) {
      const rise = (entries[i].values.inletTotaliser as number) - (entries[i - 1].values.inletTotaliser as number);
      expect(rise / days(i), entries[i].id).toBeGreaterThanOrEqual(6);
      expect(rise / days(i), entries[i].id).toBeLessThanOrEqual(10);
    }
    // the outlet meter is its own meter and reads lower: about 92 to 97% of the inlet volume
    const clean = entries.slice(-10);
    const inVol = (clean[9].values.inletTotaliser as number) - (clean[0].values.inletTotaliser as number);
    const outVol = (clean[9].values.outletTotaliser as number) - (clean[0].values.outletTotaliser as number);
    expect(outVol / inVol).toBeGreaterThan(0.9);
    expect(outVol / inVol).toBeLessThan(0.99);
    // run hours: 6.0 on most days
    const six = entries.filter((e) => e.values.runHours === 6).length;
    expect(six / entries.length).toBeGreaterThan(0.6);
    for (const e of entries) expect(e.values.runHours as number).toBeLessThanOrEqual(24);
    // chemicals every third or fourth day, sludge weekly
    const dosed = entries.filter((e) => e.values.limeKg != null);
    expect(dosed.length).toBeGreaterThanOrEqual(10);
    expect(dosed.length).toBeLessThanOrEqual(15);
    for (const e of dosed) {
      expect(e.values.alumKg).toBeGreaterThan(0);
      expect(e.values.chlorineKg).toBeGreaterThan(0);
    }
    const sludge = entries.filter((e) => e.values.sludgeKg != null);
    expect(sludge.length).toBeGreaterThanOrEqual(5);
    expect(sludge.length).toBeLessThanOrEqual(7);
  });

  it("carries the meter-change remark exactly, on the row where the reading restarts", () => {
    const { entries } = buildDailySeed(DAILY_END);
    const noted = entries.filter((e) => e.remarks);
    expect(noted).toHaveLength(1);
    expect(noted[0].remarks).toBe("energy meter changed, new meter start 90770");
    expect(noted[0].values.energyKwh).toBe(90770);
    const before = entries[entries.indexOf(noted[0]) - 1];
    expect(before.values.energyKwh as number).toBeGreaterThan(90770);
  });

  it("flags every planted problem at the entries it was planted in", () => {
    for (const end of [DAILY_END, "2026-10-04", "2027-02-28"]) {
      const { plant, entries, planted } = buildDailySeed(end);
      const flags = runChecks(plant, entries).flags;
      expect(planted.map((p) => p.ruleId).sort()).toEqual(["meter", "meter", "missing", "step", "step", "twin"]);
      const ids = new Set(entries.map((e) => e.id));
      for (const p of planted) {
        for (const id of p.entryIds) expect(ids.has(id), `${p.ruleId}: ${id}`).toBe(true);
        expect(flagFor(p, flags), `${end} ${p.ruleId}: ${p.note}`).toBeDefined();
      }
    }
  });

  it("reports each planted problem the way it was planted", () => {
    const { plant, entries } = buildDailySeed(DAILY_END);
    const r = runChecks(plant, entries);
    const by = (rule: string) => r.flags.filter((f) => f.ruleId === rule);
    // a nine-day run where energy rises by exactly 12 and the inlet meter by exactly 8
    const step = by("step");
    expect(step.map((f) => f.param).sort()).toEqual(["energyKwh", "inletTotaliser"]);
    for (const f of step) {
      expect(f.severity).toBe("medium");
      expect(f.entryIds).toHaveLength(9);
    }
    expect(step.find((f) => f.param === "energyKwh")!.detail).toContain("exactly 12 kWh");
    expect(step.find((f) => f.param === "inletTotaliser")!.detail).toContain("exactly 8 m³");
    // five days of outlet written identical to inlet, then one fall back
    expect(by("twin")).toHaveLength(1);
    expect(by("twin")[0].entryIds).toHaveLength(5);
    const meter = by("meter");
    expect(meter).toHaveLength(2);
    const down = meter.find((f) => f.severity === "high")!;
    expect(down.param).toBe("outletTotaliser");
    // the replaced energy meter is a low-severity reminder, not an error
    const replaced = meter.find((f) => f.severity === "low")!;
    expect(replaced.param).toBe("energyKwh");
    expect(replaced.title).toContain("meter replaced, confirm old and new readings");
    // one missing day, in day wording
    expect(by("missing")).toHaveLength(1);
    expect(by("missing")[0].title).toBe("Missing day");
    expect(r.expectedShifts).toBe(46);
    expect(r.recordedShifts).toBe(45);
    expect(r.complianceRate).toBeNull();
  });

  it("finds every planted problem and raises nothing else, with one high flag only, on 40 end dates", () => {
    for (let i = 0; i < 40; i++) {
      const end = i === 0 ? DAILY_END : addDays("2026-01-03", i * 13);
      const { plant, entries, planted } = buildDailySeed(end);
      const flags = runChecks(plant, entries).flags;
      // Not only on the demo date: the two nine-day runs of identical rises
      // sit over the same entries and are judged together, so neither depends
      // on how the random part of that month's rises happened to fall.
      for (const p of planted) expect(flagFor(p, flags), `${end} ${p.ruleId}: ${p.note}`).toBeDefined();
      for (const f of flags) {
        expect(planted.some((p) => explains(p, f)), `${end} ${f.severity} ${f.id}: ${f.detail}`).toBe(true);
        expect(`${f.title} ${f.detail} ${f.verify}`, f.id).not.toMatch(/shift/i);
      }
      expect(flags.filter((f) => f.severity === "high").map((f) => f.id), end).toHaveLength(1);
      // identical run hours and identical doses are normal here
      for (const rule of ["repeat", "rowcopy", "digits", "flat", "flowgap", "physical", "duplicate", "date"]) {
        expect(flags.some((f) => f.ruleId === rule), `${end} ${rule}`).toBe(false);
      }
    }
  });

  it("says so in the step flags that the two meters step together", () => {
    const { plant, entries } = buildDailySeed(DAILY_END);
    const step = runChecks(plant, entries).flags.filter((f) => f.ruleId === "step");
    expect(step.find((f) => f.param === "energyKwh")!.detail).toContain("Inlet flow meter reading rises in identical steps over the same entries");
    expect(step.find((f) => f.param === "inletTotaliser")!.detail).toContain("Energy meter rises in identical steps over the same entries");
  });

  it("stays readable when the plant is set to two or three entries a day", () => {
    // someone changing "shifts per day" on the sample plant: one flag about the
    // setting, the planted missing day, and everything else as before
    const { plant, entries } = buildDailySeed(DAILY_END);
    const base = runChecks(plant, entries).flags.filter((f) => f.ruleId !== "missing").map((f) => f.id);
    for (const perDay of [2, 3] as const) {
      const r = runChecks({ ...plant, shiftsPerDay: perDay }, entries);
      const missing = r.flags.filter((f) => f.ruleId === "missing");
      expect(missing.map((f) => f.title), String(perDay)).toEqual(["Fewer entries a day than the plant setting", "Missing entry"]);
      expect(missing[0].detail).toContain("has more than 1 entry");
      expect(missing[1].date).toBe("2026-08-14");
      expect([r.recordedShifts, r.expectedShifts]).toEqual([45, 46]);
      expect(r.flags.filter((f) => f.ruleId !== "missing").map((f) => f.id)).toEqual(base);
    }
  });

  it("keeps the last four days clean", () => {
    const { plant, entries } = buildDailySeed(DAILY_END);
    const tail = new Set(entries.slice(-4).map((e) => e.id));
    for (const f of runChecks(plant, entries).flags) {
      expect(f.entryIds.some((id) => tail.has(id)), f.id).toBe(false);
    }
  });

  it("does not crash on a malformed end date", () => {
    for (const bad of ["", "garbage", "2026-02-31", null as unknown as string]) {
      expect(buildDailySeed(bad).entries).toHaveLength(45);
    }
  });
});
