// Deterministic demo data with a handful of planted problems for the checks
// engine to find. Everything here is generated (no Math.random, no real plant):
//   buildSeed       30 days of a three-shift residential STP, lab-style sheet
//   buildDailySeed  45 daily rows of a small hospital STP, meter-and-dosing register
//
// Nothing is tidied up after generation. If the random part of the data happens
// to trip a rule, the rule is wrong (or honest about its false-positive rate);
// the seed must not hide that.

import { DEFAULT_LIMITS, PARAMS, SHIFTS, shiftsFor } from "./params";
import type { LogEntry, ParamKey, Plant, ShiftCode } from "./types";

export interface Planted {
  ruleId: string;
  note: string;
  // Entries the flag for this problem should point at. Empty where the problem
  // is an absence (a missing shift or day has no entry to point at).
  entryIds: string[];
}

export interface Seed {
  plant: Plant;
  entries: LogEntry[];
  planted: Planted[];
}

// ------------------------------------------------------------------ helpers

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

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// A malformed end date must not crash the screen that asks for demo data.
function safeEnd(endDate: string, fallback: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate ?? "");
  if (!m) return fallback;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== endDate ? fallback : endDate;
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dow(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function r(k: ParamKey, v: number): number {
  return Number(v.toFixed(PARAMS[k].decimals));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function cloneLimits(kind: "STP" | "ETP"): Plant["limits"] {
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS[kind]).map(([k, v]) => [k, { ...v }]));
}

// ------------------------------------------------- three-shift lab-style log

const DAYS = 30;
const OPERATORS = ["Ramesh", "Suresh", "Mahesh"];
const SHIFT_CODES: ShiftCode[] = ["A", "B", "C"];
const SHIFT_SHARE = [0.42, 0.36, 0.22]; // morning peak, night trough

// Planted-problem positions (day index 0..29, shift index 0..2).
const MISSING: [number, number][] = [
  [5, 1],
  [26, 0],
];
const COPY_FROM_DAY = 2; // source night shift
const COPY_DAYS = [3, 4, 5, 6, 7, 8]; // six consecutive night shifts copied
const BOD_WEEK = [19, 20, 21, 22, 23, 24, 25];
const DIGITS_OP = 0;
const PH_TYPO: [number, number] = [20, 1];
const ROLLBACK: [number, number] = [18, 1];
const END_ENERGY = 48220; // meter reading on the last entry (the sample logbook page continues from here)
// A process upset: one blower trips on the night shift, DO and MLSS fall, TSS
// and COD go over the limit, and the blower hours and energy drop with it until
// the blower is restarted the next afternoon.
const UPSET: { d: number; s: number; doV: number; mlss: number; tss: number; cod: number; blower?: number; remarks?: string }[] = [
  { d: 15, s: 1, doV: 1.2, mlss: 2900, tss: 118, cod: 190 },
  { d: 15, s: 2, doV: 0.7, mlss: 2640, tss: 134, cod: 285, blower: 3.5, remarks: "Blower 2 tripped, foaming in aeration tank" },
  { d: 16, s: 0, doV: 0.9, mlss: 2540, tss: 121, cod: 205, blower: 4.0 },
  { d: 16, s: 1, doV: 1.7, mlss: 2580, tss: 62, cod: 135, remarks: "Blower 2 restarted" },
];

// Shifts rotate weekly, backwards (B moves to A, C to B, A to C), which leaves
// at least 8 hours between a person's last shift of one week and first of the
// next. Nobody works two shifts back to back. Counted from the end so that the
// final week is always Ramesh A, Suresh B, Mahesh C, as on the sample pages.
function operatorFor(d: number, s: number): string {
  const week = Math.floor((DAYS - 1 - d) / 7);
  return OPERATORS[(((s - week) % 3) + 3) % 3];
}

// Each entry is stamped a little after its own shift ends (Indian time, written
// as UTC): A ends 14:00, B 22:00, C 06:00 the next morning.
function capturedAfterShift(date: string, s: number): string {
  if (s === 0) return `${date}T08:45:00.000Z`;
  if (s === 1) return `${date}T16:45:00.000Z`;
  return `${addDays(date, 1)}T00:45:00.000Z`;
}

const VARY_KEYS = (Object.keys(PARAMS) as ParamKey[]).filter((k) => PARAMS[k].varies);

export function buildSeed(endDate: string): Seed {
  const end = safeEnd(endDate, "2026-09-27");
  const rng = mulberry32(hashString(`jallog-seed:${end}`));
  const gauss = () => {
    const u = Math.max(rng(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };

  const plant: Plant = {
    id: "demo-plant",
    name: "Aravali Residency STP",
    kind: "STP",
    location: "Jagatpura, Jaipur",
    capacityKld: 250,
    // An activated-sludge process run on MLSS and SV30, which is what the
    // generated log records. (A pure MBBR is not controlled on MLSS.)
    technology: "Extended aeration",
    operatorCompany: "Shree O&M Services",
    consentNo: "RSPCB/CTO/2025/XXXX (sample)",
    shiftsPerDay: 3,
    limits: cloneLimits("STP"),
  };

  const startDate = addDays(end, -(DAYS - 1));
  const dates = Array.from({ length: DAYS }, (_, d) => addDays(startDate, d));
  const shifts = shiftsFor(plant.shiftsPerDay);

  // ---- base generation (all 90 slots, so the energy meter stays continuous)
  //
  // What is recorded when follows how a 250 KLD apartment plant usually keeps
  // its sheet: flows, pH, DO, chlorine, blower hours and the energy meter every
  // shift; MLSS and SV30 once a day on the morning shift; COD and TSS three
  // mornings a week and BOD once a week, as lab results. The sample logbook
  // pages in public/samples show COD and TSS on every shift because they exist
  // to exercise the extractor on a full grid; the seed aims at a realistic
  // month instead.
  type Draft = { d: number; s: number; entry: LogEntry; blower: number; kwhNoise: number };
  const drafts: Draft[] = [];
  for (let d = 0; d < DAYS; d++) {
    const date = dates[d];
    const weekday = dow(date);
    const dayTotal = 232 * (1 + 0.05 * gauss()) * (weekday === 0 || weekday === 6 ? 1.07 : 1);
    const tail = d >= DAYS - 3; // last three days: calm, joins up with the next page
    const mlssDay = Math.round(
      tail
        ? clamp(3160 + 25 * gauss(), 3100, 3200)
        : clamp((d >= DAYS - 6 ? 3160 : 3150 + 420 * Math.sin(d * 0.22 + 1)) + 70 * gauss(), 2500, 3800),
    );
    const svi = tail ? clamp(134 + 4 * gauss(), 128, 140) : clamp(112 + 16 * gauss(), 85, 145);
    const labDay = weekday === 1 || weekday === 3 || weekday === 5;
    for (let s = 0; s < shifts.length; s++) {
      const code = SHIFT_CODES[s];
      const inlet = Math.round(dayTotal * SHIFT_SHARE[s] * (1 + 0.05 * gauss()));
      // The equalisation tank evens the outlet out a little against the inlet,
      // and the outlet meter has its own scatter.
      const outlet = Math.round((0.8 * inlet + 0.2 * (dayTotal / 3)) * (0.95 + 0.025 * gauss()));
      const cod = Math.round(tail ? clamp(63 + 6 * gauss(), 50, 75) : clamp(75 + 15 * gauss(), 40, 110));
      const tss = Math.round(tail ? clamp(15 + 3 * gauss(), 10, 22) : clamp(24 + 6 * gauss(), 10, 40));
      const bod = 8 + Math.floor(rng() * 18);
      const morning = s === 0;
      const values: LogEntry["values"] = {
        inletFlow: inlet,
        outletFlow: outlet,
        phInlet: r("phInlet", clamp(7.3 + 0.25 * gauss(), 6.8, 7.8)),
        phOutlet: r("phOutlet", clamp(7.4 + 0.15 * gauss(), 7.0, 7.8)),
        doAeration: r("doAeration", clamp(2.5 + 0.4 * gauss(), 1.5, 3.5)),
        mlss: morning ? mlssDay : null,
        sv30: morning ? Math.round((mlssDay * svi) / 1000) : null,
        codOutlet: morning && labDay ? cod : null,
        bodOutlet: morning && weekday === 3 ? bod : null,
        tssOutlet: morning && labDay ? tss : null,
        residualChlorine: r("residualChlorine", clamp(0.6 + 0.12 * gauss(), 0.3, 0.9)),
        blowerHours: null,
        energyKwh: null,
      };
      const entry: LogEntry = {
        id: `seed-${date}-${code}`,
        plantId: plant.id,
        date,
        shift: code,
        time: SHIFTS[code].start,
        operator: operatorFor(d, s),
        values,
        remarks: null,
        pageId: "seed",
        capturedAt: capturedAfterShift(date, s),
      };
      drafts.push({ d, s, entry, blower: clamp(6.8 + 0.8 * gauss(), 5, 8), kwhNoise: 4 * gauss() });
    }
  }
  const find = (d: number, s: number): LogEntry => drafts.find((x) => x.d === d && x.s === s)!.entry;

  // ---- planted: upset. Extra samples are tested while it lasts, which is why
  // these shifts carry MLSS, TSS and COD outside the usual schedule.
  for (const u of UPSET) {
    const draft = drafts.find((x) => x.d === u.d && x.s === u.s)!;
    const e = draft.entry;
    e.values.doAeration = u.doV;
    e.values.mlss = u.mlss;
    e.values.sv30 = Math.round((u.mlss * 140) / 1000);
    e.values.tssOutlet = u.tss;
    e.values.codOutlet = u.cod;
    if (u.blower !== undefined) draft.blower = u.blower;
    if (u.remarks) e.remarks = u.remarks;
  }

  // ---- blower hours and the energy meter (after the upset, so both drop with
  // the tripped blower), anchored so the final reading is END_ENERGY
  let energy = 0;
  for (const x of drafts) {
    energy += Math.max(1, Math.round(x.blower * 11 + 8 + x.kwhNoise));
    x.entry.values.blowerHours = r("blowerHours", x.blower);
    x.entry.values.energyKwh = energy;
  }
  const energyShift = END_ENERGY - energy;
  for (const { entry } of drafts) entry.values.energyKwh = (entry.values.energyKwh as number) + energyShift;

  // ---- planted: operator whose DO and chlorine readings end in 0 or 5
  const upsetIds = new Set(UPSET.map((u) => find(u.d, u.s).id));
  for (const { entry } of drafts) {
    if (entry.operator !== OPERATORS[DIGITS_OP] || upsetIds.has(entry.id)) continue;
    if (rng() < 0.95) entry.values.doAeration = r("doAeration", clamp(Math.round((entry.values.doAeration as number) * 2) / 2, 1.5, 3.5));
    const u = rng();
    if (u < 0.8) entry.values.residualChlorine = 0.5;
    else if (u < 0.92) entry.values.residualChlorine = 1.0;
  }

  // ---- planted: two missing shifts
  const entries = drafts.filter((x) => !MISSING.some(([d, s]) => d === x.d && s === x.s)).map((x) => x.entry);

  // ---- planted: six consecutive night shifts copied from the one before
  const src = find(COPY_FROM_DAY, 2);
  for (const d of COPY_DAYS) {
    const e = find(d, 2);
    for (const k of VARY_KEYS) e.values[k] = src.values[k] ?? null;
  }

  // ---- planted: pH typo, energy-meter misread, BOD on every shift for a week
  find(PH_TYPO[0], PH_TYPO[1]).values.phOutlet = 71;
  find(ROLLBACK[0], ROLLBACK[1]).values.energyKwh = (find(ROLLBACK[0], ROLLBACK[1]).values.energyKwh as number) - 650;
  const bodIds: string[] = [];
  for (const d of BOD_WEEK) {
    for (let s = 0; s < 3; s++) {
      if (MISSING.some(([md, ms]) => md === d && ms === s)) continue;
      const e = find(d, s);
      e.values.bodOutlet = 8 + Math.floor(rng() * 18);
      bodIds.push(e.id);
    }
  }

  const dm = (d: number) => dates[d];
  const copyIds = COPY_DAYS.map((d) => find(d, 2).id);
  const nightOp = operatorFor(COPY_FROM_DAY, 2);
  const planted: Planted[] = [
    { ruleId: "rowcopy", note: `Night-shift rows on ${dm(COPY_DAYS[0])} to ${dm(COPY_DAYS[5])} copy the night shift of ${dm(COPY_FROM_DAY)} (operator name ${nightOp}).`, entryIds: copyIds },
    { ruleId: "repeat", note: `Every measured value is identical across those seven night shifts (${dm(COPY_FROM_DAY)} to ${dm(COPY_DAYS[5])}).`, entryIds: [src.id, ...copyIds] },
    { ruleId: "missing", note: `No entry for ${dm(MISSING[0][0])} shift ${SHIFT_CODES[MISSING[0][1]]}.`, entryIds: [] },
    { ruleId: "missing", note: `No entry for ${dm(MISSING[1][0])} shift ${SHIFT_CODES[MISSING[1][1]]}.`, entryIds: [] },
    { ruleId: "limit", note: `Outlet TSS above 100 mg/L for three consecutive shifts from ${dm(15)} shift B during an upset (DO and MLSS down, one blower tripped).`, entryIds: [find(15, 1).id, find(15, 2).id, find(16, 0).id] },
    { ruleId: "limit", note: `Outlet COD of 285 mg/L on ${dm(15)} shift C, above the 250 mg/L limit.`, entryIds: [find(15, 2).id] },
    { ruleId: "physical", note: `Outlet pH entered as 71 on ${dm(PH_TYPO[0])} shift ${SHIFT_CODES[PH_TYPO[1]]} (missing decimal point).`, entryIds: [find(PH_TYPO[0], PH_TYPO[1]).id] },
    { ruleId: "meter", note: `Energy meter reads 650 kWh lower than the previous shift on ${dm(ROLLBACK[0])} shift ${SHIFT_CODES[ROLLBACK[1]]}.`, entryIds: [find(ROLLBACK[0], ROLLBACK[1]).id] },
    { ruleId: "bodfreq", note: `Outlet BOD recorded on every shift from ${dm(BOD_WEEK[0])} to ${dm(BOD_WEEK[6])}.`, entryIds: bodIds },
    {
      ruleId: "digits",
      note: `DO and residual chlorine readings entered under ${OPERATORS[DIGITS_OP]} almost always end in 0 or 5.`,
      entryIds: entries.filter((e) => e.operator === OPERATORS[DIGITS_OP]).map((e) => e.id),
    },
  ];

  return { plant, entries, planted };
}

// ------------------------------------------- one-row-a-day dosing register

const DAILY_ENTRIES = 45;
const DAILY_SPAN = DAILY_ENTRIES + 1; // calendar days covered: one day has no entry
// The sample register page continues from these readings.
const DAILY_END = { inletTotaliser: 18460, outletTotaliser: 17105, energyKwh: 91244 };
// Chosen so that the days after the change average about 11 kWh, the rate the
// sample register page (public/samples/page-4.jpg) carries on at.
const NEW_METER_START = 90770;
const D_METER_CHANGE = 2; // day index of the energy-meter replacement
const D_MISSING = 8;
const D_STEP = [12, 13, 14, 15, 16, 17, 18, 19, 20]; // identical rises, nine days
const STEP_KWH = 12;
const STEP_M3 = 8;
const D_TWIN = [26, 27, 28, 29, 30]; // outlet reading written the same as the inlet

export function buildDailySeed(endDate: string): Seed {
  const end = safeEnd(endDate, "2026-09-20");
  const rng = mulberry32(hashString(`jallog-daily:${end}`));
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  const plant: Plant = {
    id: "demo-daily",
    name: "City Care Hospital STP",
    kind: "STP",
    location: "Malviya Nagar, Jaipur",
    capacityKld: 10,
    technology: "MBBR",
    operatorCompany: "In-house maintenance",
    consentNo: "sample",
    shiftsPerDay: 1,
    limits: cloneLimits("STP"),
  };

  const startDate = addDays(end, -(DAILY_SPAN - 1));
  const dates = Array.from({ length: DAILY_SPAN }, (_, d) => addDays(startDate, d));
  const last = DAILY_SPAN - 1;

  // ---- what actually passed through the plant each day
  const inflow: number[] = []; // m³
  const outflow: number[] = []; // m³, the outlet meter is separate and reads lower
  const kwh: number[] = [];
  for (let d = 0; d <= last; d++) {
    const step = D_STEP.includes(d);
    const q = step ? STEP_M3 : int(6, 10);
    inflow.push(q);
    outflow.push(q * (0.92 + 0.05 * rng()));
    // The new meter's start and the final reading (91244) are both fixed, which
    // settles the daily consumption at about 7 to 15 kWh (11 on average). An
    // ordinary day never shows the planted step value, so that run stays
    // exactly nine days long.
    const ordinary = () => {
      const use = int(7, 14);
      return use === STEP_KWH ? 15 : use;
    };
    kwh.push(step ? STEP_KWH : ordinary());
  }
  // Make the days after the meter change add up to exactly the fixed final
  // reading by moving ordinary days up or down one unit at a time.
  const after = (d: number) => d > D_METER_CHANGE;
  const adjustable = Array.from({ length: DAILY_SPAN }, (_, d) => d).filter((d) => after(d) && !D_STEP.includes(d));
  let gap = DAILY_END.energyKwh - NEW_METER_START - kwh.reduce((s, v, d) => s + (after(d) ? v : 0), 0);
  for (let guard = 0; gap !== 0 && guard < 10000; guard++) {
    const d = adjustable[guard % adjustable.length];
    const dir = Math.sign(gap);
    // Stay off the planted step value so no ordinary day extends that run.
    if (kwh[d] + dir === STEP_KWH || kwh[d] + dir < 7) continue;
    kwh[d] += dir;
    gap -= dir;
  }

  // ---- meter readings, worked back from the fixed final ones
  const inletAt: number[] = new Array(DAILY_SPAN);
  const outletAt: number[] = new Array(DAILY_SPAN);
  const energyAt: number[] = new Array(DAILY_SPAN);
  let inl = DAILY_END.inletTotaliser;
  let out = DAILY_END.outletTotaliser + 0.5; // the meter shows whole m³
  let en = DAILY_END.energyKwh;
  for (let d = last; d >= 0; d--) {
    inletAt[d] = inl;
    outletAt[d] = Math.floor(out);
    energyAt[d] = en;
    inl -= inflow[d];
    out -= outflow[d];
    en -= kwh[d];
  }
  // Before the change the old meter was in use, with a far higher reading.
  let old = 137900 + int(0, 60);
  for (let d = 0; d < D_METER_CHANGE; d++) {
    old += kwh[d];
    energyAt[d] = old;
  }
  energyAt[D_METER_CHANGE] = NEW_METER_START;

  // ---- rows
  const entries: LogEntry[] = [];
  let nextDose = 1;
  let doseGap = 3;
  for (let d = 0; d <= last; d++) {
    const date = dates[d];
    const dosing = d === nextDose;
    if (dosing) {
      nextDose += doseGap;
      doseGap = doseGap === 3 ? 4 : 3; // every third or fourth day
    }
    const hoursDraw = rng();
    const sludgeDraw = rng();
    const limeDraw = rng();
    if (d === D_MISSING) continue;
    const values: LogEntry["values"] = {
      inletTotaliser: inletAt[d],
      outletTotaliser: D_TWIN.includes(d) ? inletAt[d] : outletAt[d],
      // Run on a timer: the same hours most days is normal for a plant this size.
      runHours: hoursDraw < 0.8 ? 6 : hoursDraw < 0.9 ? 6.5 : hoursDraw < 0.96 ? 5.5 : 7,
      // The same doses the sample register page (public/samples/page-4.jpg)
      // carries on with: lime 500 g or 1 kg, alum 1 kg, chlorine 50 g.
      limeKg: dosing ? (limeDraw < 0.7 ? 0.5 : 1) : null,
      alumKg: dosing ? 1 : null,
      chlorineKg: dosing ? 0.05 : null,
      energyKwh: energyAt[d],
      sludgeKg: dow(date) === 6 ? r("sludgeKg", 3 + 2 * sludgeDraw) : null,
    };
    entries.push({
      id: `seed-daily-${date}`,
      plantId: plant.id,
      date,
      shift: null,
      time: null,
      operator: "Sunil",
      values,
      remarks: d === D_METER_CHANGE ? `energy meter changed, new meter start ${NEW_METER_START}` : null,
      pageId: "seed",
      capturedAt: `${date}T12:30:00.000Z`, // 18:00 Indian time, after the day's row is written
    });
  }

  const id = (d: number) => `seed-daily-${dates[d]}`;
  const planted: Planted[] = [
    { ruleId: "step", note: `Energy meter rises by exactly ${STEP_KWH} kWh on each of nine days, ${dates[D_STEP[0]]} to ${dates[D_STEP[8]]}.`, entryIds: D_STEP.map(id) },
    { ruleId: "step", note: `Inlet flow meter rises by exactly ${STEP_M3} m³ on the same nine days.`, entryIds: D_STEP.map(id) },
    { ruleId: "twin", note: `Outlet flow meter reading written identical to the inlet reading on five days, ${dates[D_TWIN[0]]} to ${dates[D_TWIN[4]]}.`, entryIds: D_TWIN.map(id) },
    { ruleId: "meter", note: `Outlet flow meter reading falls back to its own figure on ${dates[D_TWIN[4] + 1]}, so the meter appears to go down.`, entryIds: [id(D_TWIN[4] + 1)] },
    { ruleId: "missing", note: `No row for ${dates[D_MISSING]}.`, entryIds: [] },
    { ruleId: "meter", note: `Energy meter replaced on ${dates[D_METER_CHANGE]}, noted in the remarks; the reading falls to ${NEW_METER_START}.`, entryIds: [id(D_METER_CHANGE)] },
  ];

  return { plant, entries, planted };
}
