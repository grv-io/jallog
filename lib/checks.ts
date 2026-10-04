// JalLog checks engine. Pure and deterministic: no I/O, no clock, no randomness.
// Every flag is a signal for a supervisor to verify, never a verdict. No flag
// carries a person's name in its title; only the per-operator part of the
// digits rule, which compares readings by the operator name written on the
// page, mentions a name at all, and then only in the sentence with the figures.
//
// Two kinds of register have to work here:
//   - three-shift lab-style sheets (shift letters, pH/DO/MLSS/COD columns), and
//   - one-row-a-day meter-and-dosing registers (no shift, no time, cumulative
//     flow and energy meter readings, run hours, chemical doses).
// Wording switches between "shift" and "day" on plant.shiftsPerDay.
//
// The repeat / rowcopy / flat / step rules share one idea: a pattern is only
// flagged when it would be unlikely to turn up by chance in a log whose
// readings behave the way this plant's own readings behave. A pH written to
// one decimal repeats itself all the time; a flow in m³ almost never does.
// The run length needed for a flag therefore depends on the parameter.

import { PARAMS, fmt, shiftsFor } from "./params";
import { PARAM_KEYS } from "./types";
import type {
  ChecksResult,
  Flag,
  FlagCategory,
  LogEntry,
  ParamKey,
  Plant,
  Severity,
  ShiftCode,
} from "./types";

// ---------------------------------------------------------------- thresholds

// A pattern is flagged when the expected number of times it would appear by
// chance in the whole log is below this.
export const CHANCE_ALPHA = 0.01;
// Chance that two readings of one column agree exactly. Estimated from the
// log; never taken above the cap or below the floor. The cap is what a column
// with no visible variation is assumed to be. In the simulation in the tests, a
// steady outlet pH kept to one decimal (spread 0.05) agrees with the reading
// before it a little over half the time, so 0.6 lets a steady plant pass while
// a column that never moves is still flagged once it has run for a couple of
// dozen readings.
export const AGREE_CAP = 0.6;
export const AGREE_FLOOR = 0.02;
export const AGREE_MIN_VALUES = 8; // fewer values than this: assume the cap
export const AGREE_MARGIN_SE = 1; // standard errors added to the estimate
// A column recorded in coarse steps (pH by paper strip in whole numbers,
// chlorine by a comparator kit with three or four colour steps) honestly
// agrees with itself far more often than AGREE_CAP allows. Such a column is
// recognised from the log (at most COARSE_MAX_DISTINCT different values, or a
// single value that sits on a round step) and is then judged by its own
// agreement rate, up to this cap. It also cannot by itself make a repeat flag
// high: see findRepeats.
export const COARSE_AGREE_CAP = 0.95;
export const COARSE_MAX_DISTINCT = 4;
// When estimating that chance, the run being judged counts as one value and any
// other run longer than this counts as this many, so that a copied stretch can
// neither vouch for itself nor be vouched for by a second copied stretch.
export const RUN_TRUNCATE = 6;

export const REPEAT_MIN_N = 4; // never flag fewer identical readings than this
export const ROWCOPY_MIN_PARAMS = 4; // lab readings present for a row copy
export const DIGITS_MIN_VALUES = 30; // values needed for the overall digit test
export const DIGITS_MIN_VALUES_OPERATOR = 20; // values needed per operator
export const DIGITS_ROUND_SHARE = 0.6; // share ending in 0 or 5 that is flagged
// A reading that hardly moves (pH between 7.4 and 7.6) has a last digit decided
// by where it sits, not by how it is read. The digit test needs the middle 90%
// of the values to span at least this many recording steps.
export const DIGITS_MIN_SPREAD_STEPS = 5;
// Flows, MLSS and SV30 are often written to the nearest 5, 10 or 50 without that
// meaning anything. BOD and COD come out of the lab in coarse steps (BOD is a DO
// change divided by a dilution fraction; COD is a titration), so their last
// digit says nothing about how carefully they were read.
export const DIGITS_SKIP: ParamKey[] = ["inletFlow", "outletFlow", "mlss", "sv30", "codOutlet", "bodOutlet"];
export const FLAT_MIN_LEN = 25; // readings within one recording step of each other
export const FLAT_MEDIUM_LEN = 50; // a flat stretch this long is medium, else low
// pH is a log scale and a healthy outlet sits within 0.2 of itself for weeks.
export const FLAT_SKIP: ParamKey[] = ["inletFlow", "phInlet", "phOutlet"];
export const FLAT_BAND_CAP = 0.7; // assumed chance of staying in a two-value band
export const FLAT_MIN_OUTSIDE = 10; // readings outside the stretch to estimate it
export const FLAT_INLET_CV_MIN = 0.1; // same-shift inlet flow must vary by this
export const FLAT_INLET_MIN_VALUES = 8; // inlet values needed inside the stretch
export const FLAT_REPEAT_OVERLAP = 0.5; // skip flat when repeat covers this share
export const FLOW_BALANCE_TOLERANCE = 0.15; // outlet may exceed inlet by this
export const FLOW_GROSS_FACTOR = 3; // a day's inlet this many times its outlet
// Volumes are compared with the design capacity in the plant settings. A plant
// can run well over its design flow, so only a day at several times the
// capacity is questioned: by then a slipped digit or a wrong column is likelier.
export const CAPACITY_FLOW_FACTOR = 3;
// Chemical doses in kg for every m³ of daily capacity. 5 kg/m³ of lime or alum
// is 5,000 mg/L and 1 kg/m³ of chlorine is 1,000 mg/L, both far beyond what a
// treatment plant doses; grams written in the kilogram column get there easily.
export const CAPACITY_DOSE_KG_PER_M3: Partial<Record<ParamKey, number>> = { limeKg: 5, alumKg: 5, chlorineKg: 1 };
// A figure this many times the column's usual figure (its median), or this
// many times smaller, is a likely unit or decimal slip. Flows of one plant sit
// much closer together than doses do, so an extra digit (x10) already stands out.
export const SCALE_FACTOR_FLOW = 5;
export const SCALE_FACTOR = 50;
export const SCALE_MIN_VALUES = 5; // other values needed to know the usual figure
export const JUMP_FACTOR = 20; // a meter rise this many times its usual rise
// Blower hours on a row that covers a whole day may add several blowers
// together. Up to this many blowers' worth of hours is a question; more than
// that is treated as a value that cannot be right.
export const BLOWER_MAX_UNITS = 4;
export const LIMIT_RUN_MAX_GAP_DAYS = 2; // exceedances further apart are separate
export const BODFREQ_MIN_SHIFTS_PER_DAY = 2;
export const BODFREQ_MIN_DAYS = 3;
export const SVI_MIN = 30;
export const SVI_MAX = 400;
export const SV30_NOT_SETTLED = 900; // mL/L: the sludge did not settle at all
export const HUGGING_MIN_VALUES = 15;
export const HUGGING_BAND_LOW = 0.9; // band is [0.9*limit, limit]
export const HUGGING_SHARE = 0.7;
export const BACKFILL_DAYS = 3;
export const DATE_GAP_DAYS = 60; // a gap longer than this splits the log
export const DATE_OUTLIER_MAX_ENTRIES = 3; // a stray group this small is a date slip
// A slip of one month is closer than DATE_GAP_DAYS. Up to
// DATE_OUTLIER_MAX_ENTRIES entries standing this far (and this many times the
// log's usual spacing) before or after everything else are looked at again:
// they count as a date slip only when the log itself says so (see dateSlips).
export const DATE_SLIP_GAP_DAYS = 7;
export const DATE_SLIP_GAP_FACTOR = 5;
export const DATE_SLIP_MIN_BODY = 6; // entries the rest of the log must have
export const STEP_MIN_N = 6; // identical meter rises in a row
// What a meter whose rises show no variation at all is assumed to do: agree
// with its previous rise half the time. Measured in the tests: a register
// whose only meter climbs by the same amount on every row is flagged from 9
// rows; one stepping meter beside two that vary, from 11 rows; two meters
// stepping together, from 7 rows.
export const STEP_AGREE_CAP = 0.5;
// The column test: the meter's commonest rise accounts for at least this share
// of all its rises. Catches a register that steps by the same amount all the
// way down even when a missing day or one misread digit breaks the run.
export const STEP_COLUMN_SHARE = 0.9;
export const METER_DIGITS_MIN_VALUES = 10; // meter readings for the last-digit test
// A meter whose usual rise is no more than this many recording steps moves
// about one unit per entry: standing still for an entry means nothing.
export const COARSE_METER_STEPS = 2;
export const STALL_SUMMARY_MIN = 3; // separate stalls reported as one flag
export const TWIN_MIN_N = 5; // entries with inlet reading == outlet reading
export const FLOWGAP_MIN_N = 3; // entries in a row with outlet rise > inlet rise
export const FLOWGAP_TOLERANCE = 0.15;
// An industrial effluent plant in trouble can genuinely pass COD, BOD or TSS in
// the thousands, so the sewage-plant caps in params.ts do not apply to an ETP.
export const ETP_STRENGTH_MAX = 100000;

// --------------------------------------------------------------------- rules

export interface RuleInfo {
  id: string;
  category: FlagCategory;
  title: string;
  description: string;
}

export const RULES: RuleInfo[] = [
  {
    id: "limit",
    category: "compliance",
    title: "Value outside consent limit",
    description: `A reading is above the maximum or below the minimum set for the plant. Exceedances in back-to-back readings are grouped into one flag; readings more than ${LIMIT_RUN_MAX_GAP_DAYS} days apart are reported separately.`,
  },
  {
    id: "physical",
    category: "plausibility",
    title: "Value that cannot be right",
    description:
      `A value outside what the parameter can be (for example pH 71, a negative reading, or more than 24 run hours in a day), BOD above COD in the same entry, a full day's outlet flow well above its inlet flow (or its inlet flow more than ${FLOW_GROSS_FACTOR} times its outlet flow), or blower hours longer than the shift. Also figures that are out of scale: a day's flow or a flow meter's rise above ${CAPACITY_FLOW_FACTOR} times the design capacity in the plant settings, a chemical dose far too large for a plant of that capacity, a flow or dose many times larger or smaller than the column's usual figure, or a meter that jumps by ${JUMP_FACTOR} times its usual rise. These are usually a slipped digit, a wrong unit or a wrong column.`,
  },
  {
    id: "repeat",
    category: "integrity",
    title: "Repeated readings",
    description: `The same measured parameter has exactly the same value in a run of back-to-back readings (at least ${REPEAT_MIN_N}). How long the run must be depends on the parameter: it is flagged only when a run that long would be unlikely by chance given how often that parameter's readings agree elsewhere in the log. High severity only when two or more parameters repeat over the same entries and at least one of them is a finely recorded reading. A column recorded in coarse steps (a pH strip in whole numbers, a comparator kit; recognised by having at most ${COARSE_MAX_DISTINCT} different values in the log) repeats itself honestly and is judged by its own rate of agreement.`,
  },
  {
    id: "rowcopy",
    category: "integrity",
    title: "Row identical to the previous row",
    description: `An entry whose lab readings (at least ${ROWCOPY_MIN_PARAMS} of them) all equal the previous entry's, where that much agreement would be unlikely by chance. Flow figures are ignored, so a row with fresh flows but copied lab values still counts. Consecutive such rows are grouped.`,
  },
  {
    id: "digits",
    category: "integrity",
    title: "Readings mostly end in 0 or 5",
    description: `At least ${Math.round(DIGITS_ROUND_SHARE * 100)}% of a parameter's recorded last digits are 0 or 5 (about 20% is expected). Tested on all values, and per operator name where one name has enough values and the rest of the log does not show the pattern. It suggests rounding by habit or a coarse instrument. Where every reading sits on a round step (whole numbers, or steps of 0.5) the method itself is coarse, and that is reported once as a low-severity note instead. Not tested on BOD, COD, flows, MLSS and SV30, or on a reading that barely moves (its last digit then depends on where it sits, not on how it is read). Meter readings are tested too (from ${METER_DIGITS_MIN_VALUES} readings): a meter's last digit does not depend on the process, so readings that nearly all end in 0 or 5 are either rounded or come from a meter that counts in fives or tens.`,
  },
  {
    id: "flat",
    category: "integrity",
    title: "Reading almost constant while inflow varies",
    description: `A measured parameter (not pH) stays within one recording step for ${FLAT_MIN_LEN} or more readings in a row, a stretch that would be unlikely given the rest of the log, while inlet flow for the same shifts varies by more than ${FLAT_INLET_CV_MIN * 100}%.`,
  },
  {
    id: "missing",
    category: "completeness",
    title: "Missing entries",
    description: `Between the first and last entry in the log, every expected shift (or every day, at a one-entry-a-day plant) should have an entry. Each contiguous gap is one flag. A break of more than ${DATE_GAP_DAYS} days is reported once and not counted shift by shift. When no day in the log has as many entries as the plant setting expects (or most days have more), that is reported once as a setting to check, and the count of expected entries follows what the register actually records.`,
  },
  {
    id: "date",
    category: "completeness",
    title: "Entry date needs checking",
    description: `An entry with no usable date, or dated more than ${DATE_GAP_DAYS} days away from the rest of the log (usually a mistyped year). A date nearer than that is questioned only when the log itself points to a slip: up to ${DATE_OUTLIER_MAX_ENTRIES} entries standing more than ${DATE_SLIP_GAP_DAYS} days before or after everything else, where the same day of the neighbouring month has no entry or the entry's meter reading belongs among the earlier rows. Such entries are left out of the checks that depend on order until the date is corrected. A wrong date that lands inside the log's own period cannot be told apart from a right one.`,
  },
  {
    id: "duplicate",
    category: "completeness",
    title: "Duplicate entries",
    description:
      "The same date and shift entered more than once. Exact copies (for example the same page uploaded twice) are counted once by every other check. Two entries for the same slot with different readings are reported so one can be corrected.",
  },
  {
    id: "bodfreq",
    category: "plausibility",
    title: "BOD recorded more than once a day",
    description:
      "BOD takes 3 days at 27 °C or 5 days at 20 °C to measure, so it cannot be a per-shift reading. Flagged when outlet BOD is entered in two or more shifts on the same day on at least 3 days.",
  },
  {
    id: "meter",
    category: "plausibility",
    title: "Meter went backwards or stood still",
    description:
      `A cumulative meter (energy meter, inlet or outlet flow meter) must never go down. A fall is high severity, unless the remarks on that or the neighbouring entry mention a meter change (or the fall comes after a break of more than ${DATE_GAP_DAYS} days in the log), in which case it is a low-severity reminder to confirm the old and new readings. A meter that does not move across an entry where run hours were recorded is medium severity; a meter that only moves about one unit per entry is reported once, at low severity, instead of at every entry where it stood still.`,
  },
  {
    id: "step",
    category: "integrity",
    title: "Meter rises in identical steps",
    description: `A cumulative meter rises by exactly the same amount in ${STEP_MIN_N} or more entries in a row, or in at least ${Math.round(STEP_COLUMN_SHARE * 100)}% of all its rises (so a missing day or one misread digit does not hide it), where that would be unlikely given how the meter's rises vary elsewhere in the log. Two meters stepping over the same entries are judged together. A meter that is read each day rarely climbs in identical steps.`,
  },
  {
    id: "twin",
    category: "plausibility",
    title: "Inlet and outlet meters show the same reading",
    description: `The inlet and outlet flow meter readings are exactly equal on ${TWIN_MIN_N} or more entries. Two separate meters would not be expected to agree to the digit, so either the plant has one meter or one column was written from the other.`,
  },
  {
    id: "flowgap",
    category: "plausibility",
    title: "Outlet meter rising faster than inlet meter",
    description: `Where both flow meter readings are recorded, the outlet reading rises by more than ${Math.round(FLOWGAP_TOLERANCE * 100)}% above the inlet reading's rise in ${FLOWGAP_MIN_N} or more entries in a row.`,
  },
  {
    id: "svi",
    category: "plausibility",
    title: "MLSS and SV30 give an unusual SVI",
    description: `SVI = SV30 x 1000 / MLSS. Flagged below ${SVI_MIN} or above ${SVI_MAX} mL/g: either one of the two readings is off, or (when SV30 is ${SV30_NOT_SETTLED} mL/L or more) the sludge did not settle.`,
  },
  {
    id: "hugging",
    category: "integrity",
    title: "Readings cluster just under the limit",
    description: `At least ${Math.round(HUGGING_SHARE * 100)}% of a parameter's values sit between ${Math.round(HUGGING_BAND_LOW * 100)}% and 100% of its maximum limit (needs ${HUGGING_MIN_VALUES}+ values). Not applied to pH, or to any limit with a minimum as well as a maximum: a share of a pH limit is not a meaningful band.`,
  },
  {
    id: "backfill",
    category: "completeness",
    title: "Entries digitised well after their dates",
    description: `A note, not a problem with the readings: entries photographed or typed in more than ${BACKFILL_DAYS} days after the dates they record, grouped by the day they were digitised. Checks can only be as prompt as the photos.`,
  },
  {
    id: "ahead",
    category: "integrity",
    title: "Entries dated after the page was photographed",
    description:
      "An entry whose date is later than the day it was photographed or typed in (Indian time). Grouped by the day of the photo. Either the row was written before its day, or its date was misread. A night-shift row dated the next day is not counted once the night shift has begun, since some plants date that shift by the morning it ends.",
  },
];

const RULE_BY_ID: Record<string, RuleInfo> = Object.fromEntries(RULES.map((r) => [r.id, r]));

// ------------------------------------------------------------------- helpers

const SHIFT_START: Record<ShiftCode, number> = { A: 360, B: 840, C: 1320 }; // minutes
const SEV_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^\s*(\d{1,2}):(\d{2})/;
const DAY_MS = 86400000;
const IST_OFFSET_MS = 5.5 * 3600000; // capture times are compared in Indian time
const NO_SLOT = 1e6;

type Lim = { min?: number; max?: number };

function isShift(s: unknown): s is ShiftCode {
  return s === "A" || s === "B" || s === "C";
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// "9:05" -> 545. null when the text is not a clock time.
function clockMin(t: unknown): number | null {
  if (typeof t !== "string") return null;
  const m = TIME_RE.exec(t);
  if (!m) return null;
  const h = +m[1];
  const mi = +m[2];
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return (h % 24) * 60 + mi;
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Day number of a YYYY-MM-DD date, or null when it is not a real calendar date.
// setUTCFullYear is used because Date.UTC maps years 0..99 onto 1900..1999.
function dayNumOf(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = DATE_RE.exec(d);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const da = +m[3];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, da);
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) return null;
  return Math.round(dt.getTime() / DAY_MS);
}

function dateFromDayNum(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// "15 Sep", or "15 Sep 2021" when the year would otherwise be a guess: the log
// runs over more than one year, was digitised in a different year from the one
// it records, or this date is not in the log's own year.
function fmtDate(c: Ctx, d: unknown, withYear = false): string {
  if (dayNumOf(d) === null) {
    const raw = typeof d === "string" ? d.trim() : "";
    return raw ? `"${clip(raw, 20)}"` : "(no date)";
  }
  const m = DATE_RE.exec(d as string)!;
  const year = withYear || c.showYear || (c.year !== null && m[1] !== c.year);
  return `${+m[3]} ${MONTHS[+m[2] - 1]}${year ? ` ${m[1]}` : ""}`;
}

function dateRange(c: Ctx, a: string, b: string): string {
  return a === b ? fmtDate(c, a) : `${fmtDate(c, a)} to ${fmtDate(c, b)}`;
}

function num(e: LogEntry, k: ParamKey): number | null {
  const v = e.values?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function same(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function shortNum(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
}

// The value at the parameter's usual precision, or in full when it was written
// with more decimals than that (a totaliser read as 238.15).
function fv(k: ParamKey, v: number | null): string {
  if (v === null) return "–";
  const d = PARAMS[k].decimals;
  return same(Number(v.toFixed(d)), v) ? fmt(k, v) : shortNum(v);
}

function unitOf(k: ParamKey): string {
  return PARAMS[k].unit ? ` ${PARAMS[k].unit}` : "";
}

function show(k: ParamKey, v: number): string {
  return `${fv(k, v)}${unitOf(k)}`;
}

function toFinite(x: unknown): number | undefined {
  if (typeof x === "number") return Number.isFinite(x) ? x : undefined;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// A limit as the rules can use it: finite sides only. A cleared form field
// leaves null, NaN or "" behind; a limit with neither side set is no limit.
function normLim(lim: unknown): Lim | null {
  if (!lim || typeof lim !== "object") return null;
  let min = toFinite((lim as { min?: unknown }).min);
  let max = toFinite((lim as { max?: unknown }).max);
  if (min === undefined && max === undefined) return null;
  if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];
  const out: Lim = {};
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  return out;
}

function limStr(k: ParamKey, lim: Lim): string {
  const u = unitOf(k);
  if (lim.min !== undefined && lim.max !== undefined) return `${fv(k, lim.min)} to ${fv(k, lim.max)}${u}`;
  if (lim.max !== undefined) return `max ${fv(k, lim.max)}${u}`;
  return `min ${fv(k, lim.min as number)}${u}`;
}

function outside(lim: Lim, v: number): boolean {
  return (lim.min !== undefined && v < lim.min) || (lim.max !== undefined && v > lim.max);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function median(vals: number[]): number {
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// P(X >= k) for X counting successes in n tries that each succeed with chance p.
function binomTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // At or below the expected count the tail is large; calling it 1 is on the
  // safe side and avoids a first term too small to represent.
  if (k <= n * p) return 1;
  let logPmf = k * Math.log(p) + (n - k) * Math.log(1 - p);
  for (let i = 1; i <= k; i++) logPmf += Math.log((n - k + i) / i);
  let pmf = Math.exp(logPmf);
  let sum = 0;
  for (let x = k; x <= n; x++) {
    sum += pmf;
    pmf *= ((n - x) / (x + 1)) * (p / (1 - p));
    if (pmf < sum * 1e-16) break;
  }
  return Math.min(1, sum);
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

const VARY_KEYS = PARAM_KEYS.filter((k) => PARAMS[k].varies);
// Lab and instrument readings: what a copied row copies. Flows are left out
// because they are often read fresh from a meter even when the rest is copied.
const LAB_KEYS = VARY_KEYS.filter((k) => k !== "inletFlow" && k !== "outletFlow");
const CUMULATIVE_KEYS = PARAM_KEYS.filter((k) => PARAMS[k].kind === "cumulative");
const FLOW_KEYS: ParamKey[] = ["inletFlow", "outletFlow"];
const FLOW_METERS: ParamKey[] = ["inletTotaliser", "outletTotaliser"];
// Quantities whose honest values stay within a narrow range of each other, so
// that one far outside it is a likely unit or decimal slip.
const SCALE_KEYS: ParamKey[] = ["inletFlow", "outletFlow", "limeKg", "alumKg", "chlorineKg", "sludgeKg"];
// Concentrations whose "physical" maximum is really "more than a plant of this
// kind would show": a value above it may be a slip or a very large exceedance.
const STRENGTH_KEYS: ParamKey[] = ["codOutlet", "bodOutlet", "tssOutlet"];
const OUTLET_KEYS: ParamKey[] = ["phOutlet", "codOutlet", "bodOutlet", "tssOutlet", "residualChlorine"];

// How a measured column is judged by the repeat and rowcopy rules.
interface Grain {
  coarse: boolean; // recorded in a few coarse steps (paper strip, comparator kit)
  cap: number; // highest chance of agreement the column may be credited with
  fallback: number; // assumed when there are too few values to estimate it
}

const FINE: Grain = { coarse: false, cap: AGREE_CAP, fallback: AGREE_CAP };

interface Ctx {
  plant: Plant;
  perDay: 1 | 2 | 3;
  daily: boolean; // one entry a day: say "day" and "entry", never "shift"
  all: LogEntry[]; // every entry once, in order
  seq: LogEntry[]; // entries with a usable date that belongs to the log, in order
  day: Map<LogEntry, number>; // day number of every entry with a real date
  lims: Partial<Record<ParamKey, Lim>>;
  capacity: number | null; // design capacity in m³ a day, when the settings give one
  showYear: boolean; // print the year with every date
  year: string | null; // the one calendar year the log sits in, when there is one
  grain: Map<ParamKey, Grain>;
}

function physMax(c: Ctx, k: ParamKey): number {
  if (c.plant?.kind === "ETP" && STRENGTH_KEYS.includes(k)) return Math.max(PARAMS[k].physicalMax, ETP_STRENGTH_MAX);
  return PARAMS[k].physicalMax;
}

function inPhysical(c: Ctx, k: ParamKey, v: number): boolean {
  return v >= PARAMS[k].physicalMin && v <= physMax(c, k);
}

// Whether the limit rule and the compliance rate should judge this value.
// Impossible values (pH 71, COD -40) are typos, not exceedances. A strength
// reading above its cap might be either, so it is judged.
function judged(c: Ctx, k: ParamKey, v: number): boolean {
  if (v < PARAMS[k].physicalMin) return false;
  return v <= physMax(c, k) || STRENGTH_KEYS.includes(k);
}

function where(c: Ctx, e: LogEntry): string {
  const d = fmtDate(c, e.date);
  if (!c.daily && isShift(e.shift)) return `${d}, shift ${e.shift}`;
  const t = clockMin(e.time);
  return t === null ? d : `${d}, ${hhmm(t)}`;
}

function fromTo(c: Ctx, first: LogEntry, last: LogEntry): string {
  const a = where(c, first);
  const b = where(c, last);
  return a === b ? `on ${a}` : `from ${a} to ${b}`;
}

function mk(
  ruleId: string,
  idScope: string,
  severity: Severity,
  detail: string,
  verify: string,
  entries: LogEntry[],
  extra: { param?: ParamKey; title?: string; date?: string } = {},
): Flag {
  const rule = RULE_BY_ID[ruleId];
  // Only a real calendar date goes out as the flag's date; screens sort on it.
  const date = extra.date ?? entries[0]?.date;
  return {
    id: `${ruleId}:${idScope}`,
    ruleId,
    category: rule.category,
    severity,
    title: extra.title ?? rule.title,
    detail,
    verify,
    param: extra.param,
    date: dayNumOf(date) !== null ? date : undefined,
    entryIds: entries.map((e) => e.id).filter((id) => typeof id === "string"),
  };
}

// ----------------------------------------------------- chance of agreement

// How likely two readings of one column are to be exactly equal, judged from
// the column itself. Three estimates, the largest wins: the share of all pairs
// that agree (coarse recording), the share of neighbouring pairs that agree
// (slow drift) and, for a run of one particular value, how much of the column
// is that value (a strip that reads 7 on most days will read 7 next time far
// more often than two readings picked at random agree). The run under test
// counts as a single value, and other long runs are cut to RUN_TRUNCATE values.
//
// The counting is done once per column (agreeStats); the chance with one run
// left out is then worked out from those counts, so that a long log made of
// many runs does not rescan the whole column for each of them.
interface AgreeStats {
  values: number[];
  blockLen: number[]; // for each value, the length of its run of equal neighbours
  truncate: number; // longest run kept
  len: number; // values kept once long runs are cut short
  pairs: number; // ordered pairs of kept values that agree
  adjacent: number; // neighbouring kept values that agree
  counts: Map<number, number>;
}

function valueKey(v: number): number {
  return Math.round(v * 1000);
}

// A column recorded in coarse steps is not cut short: long runs are its
// ordinary behaviour, and cutting them would understate how often it agrees.
function agreeStats(values: number[], grain: Grain = FINE): AgreeStats {
  const truncate = grain.coarse ? Infinity : RUN_TRUNCATE;
  const n = values.length;
  const blockLen: number[] = new Array(n);
  const counts = new Map<number, number>();
  let len = 0;
  let adjacent = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && same(values[j + 1], values[i])) j++;
    const size = j - i + 1;
    for (let x = i; x <= j; x++) blockLen[x] = size;
    const kept = Math.min(size, truncate);
    const key = valueKey(values[i]);
    counts.set(key, (counts.get(key) ?? 0) + kept);
    len += kept;
    adjacent += kept - 1;
    i = j + 1;
  }
  let pairs = 0;
  for (const c of counts.values()) pairs += c * (c - 1);
  return { values, blockLen, truncate, len, pairs, adjacent, counts };
}

// The chance of agreement with values[from..to] counted as one value.
function chanceFrom(st: AgreeStats, grain: Grain, from = -1, to = -1): number {
  let len = st.len;
  let pairs = st.pairs;
  let adjacent = st.adjacent;
  let ofValue = 0; // kept values equal to the run's value, the run counting once
  if (from >= 0 && to > from && from < st.values.length) {
    const size = st.blockLen[from];
    const removed = Math.min(to - from, size - 1);
    const drop = Math.min(size, st.truncate) - Math.min(size - removed, st.truncate);
    const c = st.counts.get(valueKey(st.values[from])) as number;
    ofValue = c - drop;
    if (drop > 0) {
      pairs += (c - drop) * (c - drop - 1) - c * (c - 1);
      adjacent -= drop;
      len -= drop;
    }
  }
  if (len < AGREE_MIN_VALUES) return grain.fallback;
  const p = Math.max(pairs / (len * (len - 1)), adjacent / (len - 1), ofValue / len);
  // An estimate from a few dozen readings is rough; lean towards "agrees more
  // often" by its standard error so that the roughness cannot cause a flag.
  const upper = p + AGREE_MARGIN_SE * Math.sqrt((p * (1 - p)) / (len - 1));
  return Math.min(grain.cap, Math.max(AGREE_FLOOR, upper));
}

function agreeChance(values: number[], grain: Grain = FINE): number {
  return chanceFrom(agreeStats(values, grain), grain);
}

// The round step every value of a column sits on, in the parameter's units:
// ten recording steps (whole numbers for a reading kept to one decimal) or five
// (halves). null when the values use the full recording precision.
function roundStep(k: ParamKey, vals: number[]): number | null {
  if (!vals.length) return null;
  const scale = 10 ** PARAMS[k].decimals;
  let tens = true;
  for (const v of vals) {
    const scaled = v * scale;
    const units = Math.round(scaled);
    if (Math.abs(scaled - units) > 1e-6 || units % 5 !== 0) return null;
    if (units % 10 !== 0) tens = false;
  }
  return (tens ? 10 : 5) / scale;
}

// Whether a column is recorded in coarse steps, judged from its own values.
function grainOf(k: ParamKey, vals: number[]): Grain {
  if (vals.length < AGREE_MIN_VALUES) return FINE;
  const distinct = new Set(vals.map(valueKey)).size;
  if (distinct > COARSE_MAX_DISTINCT) return FINE;
  const round = roundStep(k, vals) !== null;
  // A single value that never changes is only "coarse" when it sits on a round
  // step (pH 7, chlorine 0.5). A column stuck on 7.2 is a different matter.
  if (distinct === 1 && !round) return FINE;
  return { coarse: true, cap: COARSE_AGREE_CAP, fallback: round ? COARSE_AGREE_CAP : AGREE_CAP };
}

// ---------------------------------------------- preparing the list of entries

function valuesSig(e: LogEntry): string {
  return PARAM_KEYS.map((k) => {
    const v = num(e, k);
    return v === null ? "" : String(v);
  }).join("|");
}

function slotMin(e: LogEntry): number {
  if (isShift(e.shift)) return SHIFT_START[e.shift];
  return clockMin(e.time) ?? NO_SLOT;
}

function timeRank(e: LogEntry): number {
  const t = clockMin(e.time);
  if (t === null) return -1;
  // The night shift runs past midnight: 02:00 comes after 23:00 within it.
  return e.shift === "C" && t < SHIFT_START.A ? t + 1440 : t;
}

function sortEntries(entries: LogEntry[]): LogEntry[] {
  // The serialised values are the last tie-break so that even entries sharing
  // an id come out in the same order whatever order they went in.
  const sig = new Map<LogEntry, string>();
  const key = (e: LogEntry) => {
    let s = sig.get(e);
    if (s === undefined) {
      s = `${valuesSig(e)}#${e.operator ?? ""}#${e.remarks ?? ""}#${e.pageId ?? ""}#${e.capturedAt ?? ""}`;
      sig.set(e, s);
    }
    return s;
  };
  return [...entries].sort(
    (a, b) =>
      cmpStr(String(a.date ?? ""), String(b.date ?? "")) ||
      slotMin(a) - slotMin(b) ||
      timeRank(a) - timeRank(b) ||
      cmpStr(String(a.id ?? ""), String(b.id ?? "")) ||
      cmpStr(key(a), key(b)),
  );
}

function normPerDay(x: unknown): 1 | 2 | 3 {
  return x === 1 || x === 2 || x === 3 ? x : 3;
}

interface Prepared {
  c: Ctx;
  flags: Flag[]; // duplicate and date flags, which need the raw list
}

// Entries in date order, split wherever more than DATE_GAP_DAYS pass with nothing.
function clustersOf(dated: LogEntry[], day: Map<LogEntry, number>): LogEntry[][] {
  const clusters: LogEntry[][] = [];
  for (const e of dated) {
    const last = clusters[clusters.length - 1];
    if (last && (day.get(e) as number) - (day.get(last[last.length - 1]) as number) <= DATE_GAP_DAYS) last.push(e);
    else clusters.push([e]);
  }
  return clusters;
}

function largest(clusters: LogEntry[][]): LogEntry[] | null {
  return clusters.reduce<LogEntry[] | null>((m, cl) => (m === null || cl.length > m.length ? cl : m), null);
}

// Whether dates need their year printed. "15 Sep" is enough for a month that
// is being logged as it happens; it is not for a register from 2021
// photographed in 2026, or for a log that runs past twelve months.
function yearsOf(dated: LogEntry[], day: Map<LogEntry, number>): { showYear: boolean; year: string | null } {
  const clusters = clustersOf(dated, day);
  const main = largest(clusters);
  // Stray entries with a mistyped year are left out: they get a flag of their own.
  let body = clusters.filter((cl) => cl === main || cl.length > DATE_OUTLIER_MAX_ENTRIES).flat();
  // With only a handful of scattered entries there is no log for a stray one
  // to be stray from: go by all of them.
  if (body.length <= DATE_OUTLIER_MAX_ENTRIES) body = dated;
  if (!body.length) return { showYear: false, year: null };
  const years = new Set(body.map((e) => e.date.slice(0, 4)));
  const span = (day.get(body[body.length - 1]) as number) - (day.get(body[0]) as number);
  let showYear = years.size > 1 || span > 300;
  for (const e of body) {
    if (showYear) break;
    if (typeof e.capturedAt !== "string") continue;
    const cap = Date.parse(e.capturedAt);
    if (Number.isNaN(cap)) continue;
    if (String(new Date(cap + IST_OFFSET_MS).getUTCFullYear()) !== e.date.slice(0, 4)) showYear = true;
  }
  return { showYear, year: years.size === 1 ? [...years][0] : null };
}

// A date that is one month out sits well inside DATE_GAP_DAYS, so the split
// above cannot see it. This looks at up to DATE_OUTLIER_MAX_ENTRIES entries
// standing apart at the start or the end of the log, and calls one a slip only
// when the log itself says so: the same day of the neighbouring month (or
// year) lies inside the log and has no entry, or the entry's meter reading
// belongs among the rows on the other side of the gap. An entry that merely
// follows a quiet week (someone starts logging again) is left alone.
function dateSlips(c: Ctx, main: LogEntry[]): { e: LogEntry; detail: string }[] {
  const out: { e: LogEntry; detail: string }[] = [];
  if (main.length <= DATE_SLIP_MIN_BODY) return out;
  const dn = (e: LogEntry) => c.day.get(e) as number;
  const gaps: number[] = [];
  for (let i = 1; i < main.length; i++) {
    const g = dn(main[i]) - dn(main[i - 1]);
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return out;
  const limit = Math.max(DATE_SLIP_GAP_DAYS, DATE_SLIP_GAP_FACTOR * median(gaps));
  let head = 0; // how many entries stand apart at the start
  for (let i = Math.min(DATE_OUTLIER_MAX_ENTRIES, main.length - 1); i >= 1; i--) {
    if (dn(main[i]) - dn(main[i - 1]) > limit) {
      head = i;
      break;
    }
  }
  let tail = main.length; // where the entries standing apart at the end begin
  for (let i = Math.max(1, main.length - DATE_OUTLIER_MAX_ENTRIES); i < main.length; i++) {
    if (dn(main[i]) - dn(main[i - 1]) > limit) {
      tail = i;
      break;
    }
  }
  if (head === 0 && tail === main.length) return out;
  const body = main.slice(head, tail);
  if (body.length < DATE_SLIP_MIN_BODY) return out;
  const first = dn(body[0]);
  const last = dn(body[body.length - 1]);
  const byDate = groupBy(body, (e) => e.date);

  const judge = (e: LogEntry, after: boolean) => {
    const notes: string[] = [];
    const m = DATE_RE.exec(e.date)!;
    const lettered = !c.daily && isShift(e.shift);
    const shifts: [number, string][] = [
      [-1, "a month earlier"],
      [1, "a month later"],
      [-12, "a year earlier"],
      [12, "a year later"],
    ];
    for (const [by, text] of shifts) {
      const months = +m[1] * 12 + (+m[2] - 1) + by;
      const alt = `${String(Math.floor(months / 12)).padStart(4, "0")}-${String((months % 12) + 1).padStart(2, "0")}-${m[3]}`;
      const n = dayNumOf(alt);
      if (n === null || n < first || n > last) continue;
      const there = byDate.get(alt) ?? [];
      if (lettered ? there.some((x) => x.shift === e.shift) : there.length > 0) continue;
      notes.push(`There is no ${lettered ? `shift ${e.shift} ` : ""}entry for ${fmtDate(c, alt, true)}, the same day ${text}.`);
      break;
    }
    for (const k of CUMULATIVE_KEYS) {
      const v = num(e, k);
      if (v === null || meterChangeScope(e.remarks).includes(k)) continue;
      const reads = body.filter((x) => num(x, k) !== null);
      if (reads.length < 2) continue;
      const lo = num(reads[0], k) as number;
      const hi = num(reads[reads.length - 1], k) as number;
      if (after ? !(v < hi - 1e-9 && v >= lo) : !(v > lo + 1e-9 && v <= hi)) continue;
      const j = reads.findIndex((x) => (num(x, k) as number) > v);
      if (j < 1) continue;
      notes.push(
        `${PARAMS[k].label} on this entry (${fv(k, v)}) belongs between the readings of ${where(c, reads[j - 1])} and ${where(c, reads[j])}.`,
      );
      break;
    }
    if (!notes.length) return;
    const away = after ? dn(e) - last : first - dn(e);
    out.push({
      e,
      detail: `An entry is dated ${e.date}, ${away} days ${after ? "after" : "before"} the other entries (${body[0].date} to ${body[body.length - 1].date}). ${notes.join(" ")}`,
    });
  };
  for (const e of main.slice(0, head)) judge(e, false);
  for (const e of main.slice(tail)) judge(e, true);
  return out;
}

function prepare(plant: Plant, entries: LogEntry[]): Prepared {
  const perDay = normPerDay(plant?.shiftsPerDay);
  const daily = perDay === 1;
  const lims: Partial<Record<ParamKey, Lim>> = {};
  for (const k of PARAM_KEYS) {
    const l = normLim(plant?.limits?.[k]);
    if (l) lims[k] = l;
  }
  const cap = toFinite(plant?.capacityKld);

  const usable = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === "object");
  const seenId = new Set<string>();
  const sorted = sortEntries(usable).filter((e) => {
    if (typeof e.id !== "string" || e.id === "") return true;
    if (seenId.has(e.id)) return false; // the same stored entry passed twice
    seenId.add(e.id);
    return true;
  });

  const day = new Map<LogEntry, number>();
  for (const e of sorted) {
    const n = dayNumOf(e.date);
    if (n !== null) day.set(e, n);
  }
  const c: Ctx = {
    plant,
    perDay,
    daily,
    all: sorted,
    seq: [],
    day,
    lims,
    capacity: cap !== undefined && cap > 0 ? cap : null,
    ...yearsOf(sorted.filter((e) => day.has(e)), day),
    grain: new Map(),
  };
  const flags: Flag[] = [];

  // ---- duplicates: same date and slot entered twice
  const all: LogEntry[] = [];
  const dropped: { kept: LogEntry; dup: LogEntry }[] = [];
  const conflicts: LogEntry[][] = [];
  const bySlot = groupBy(sorted, (e) => `${e.date ?? ""}|${e.shift ?? ""}|${e.time ?? ""}`);
  for (const es of bySlot.values()) {
    const labelled = isShift(es[0].shift) || clockMin(es[0].time) !== null;
    const kept: LogEntry[] = [];
    // The first entry kept for each set of readings. Rows with neither shift
    // nor time at a multi-shift plant are the day's unlabelled readings, and
    // may honestly be equal: they only count as a re-upload when they come
    // from different pages (so every kept row with the same readings shares
    // one page, and looking at the first of them is enough).
    const firstWith = new Map<string, LogEntry>();
    for (const e of es) {
      const sig = valuesSig(e);
      const first = firstWith.get(sig);
      if (first && (labelled || daily || (first.pageId ?? null) !== (e.pageId ?? null))) dropped.push({ kept: first, dup: e });
      else {
        kept.push(e);
        if (!first) firstWith.set(sig, e);
      }
    }
    all.push(...kept);
    if (kept.length > 1 && (labelled || daily) && dayNumOf(kept[0].date) !== null) conflicts.push(kept);
  }

  // More rows a day than the plant setting, day after day, is a setting that
  // does not match the register, not a string of conflicting entries.
  const rowsOn = new Map<string, number>();
  for (const e of all) if (day.has(e)) rowsOn.set(e.date, (rowsOn.get(e.date) ?? 0) + 1);
  const counts = [...rowsOn.values()];
  const over = counts.filter((n) => n > perDay).length;
  const overSetting = counts.length >= 3 && over * 2 >= counts.length;
  if (overSetting) {
    const most = Math.max(...counts);
    const firstDate = [...rowsOn.keys()].sort()[0];
    flags.push(
      mk(
        "missing",
        "over",
        "medium",
        `${over} of the ${counts.length} days in the log have more than ${perDay} ${plural(perDay, "entry", "entries")} (up to ${most} a day), and the plant is set to ${perDay} ${plural(perDay, "entry", "entries")} a day.`,
        "If the plant records more readings a day than this, change the entries per day in the plant settings, so that a missed reading can be noticed. Otherwise check whether rows from another date or another plant were saved here.",
        [],
        { title: "More entries a day than the plant setting", date: firstDate },
      ),
    );
  }
  for (const kept of conflicts) {
    // At a one-entry-a-day plant the setting flag above already covers these.
    if (daily && overSetting) continue;
    const slot = where(c, kept[0]);
    flags.push(
      mk(
        "duplicate",
        `conflict:${kept[0].id}`,
        "medium",
        `${kept.length} entries are recorded for ${slot} with different readings.${daily ? " This plant is set to one entry a day." : ""}`,
        `Compare both with the page for ${slot}: one may carry the wrong date${daily ? "" : " or shift"}, or be a corrected copy of the other. Keep the right one and delete or re-date the other.`,
        kept,
        { title: `Two entries for the same ${daily ? "day" : "shift"} disagree` },
      ),
    );
  }
  if (dropped.length) {
    // One flag per source page of the copies, so a page uploaded twice is one flag.
    for (const ds of groupBy(dropped, (d) => d.dup.pageId ?? "-").values()) {
      const dates = ds.map((d) => String(d.dup.date ?? "")).sort();
      const n = ds.length;
      flags.push(
        mk(
          "duplicate",
          `copy:${ds[0].dup.id}`,
          "low",
          `${n} ${plural(n, "entry", "entries")} for ${dateRange(c, dates[0], dates[n - 1])} ${plural(n, "is an exact copy of an entry", "are exact copies of entries")} already in the log (same date, same ${daily ? "day" : "shift or time"}, same readings). Every check counts ${plural(n, "it", "each")} once.`,
          "Check whether the same page was uploaded twice, and delete the extra copy from the log.",
          ds.flatMap((d) => [d.kept, d.dup]),
          { title: plural(n, "Duplicate entry", "Duplicate entries"), date: dates[0] },
        ),
      );
    }
  }
  // Grouping by slot disturbed the order; restore it (the sort is deterministic).
  c.all = sortEntries(all);

  // ---- dates: no usable date, or far away from the rest of the log
  const dated = c.all.filter((e) => day.has(e));
  for (const e of c.all) {
    if (day.has(e)) continue;
    const raw = typeof e.date === "string" ? e.date.trim() : "";
    flags.push(
      mk(
        "date",
        `invalid:${e.id}`,
        "medium",
        raw
          ? `An entry is dated "${clip(raw, 20)}", which is not a real calendar date.`
          : "An entry has no date.",
        "Open the entry and set its date from the page. Until then it is left out of the checks that depend on order (missing entries, meter readings, repeats).",
        [e],
        { title: "Entry without a usable date" },
      ),
    );
  }
  const clusters = clustersOf(dated, day);
  const main = largest(clusters);
  const slips = main ? dateSlips(c, main) : [];
  const slipped = new Set(slips.map((s) => s.e));
  for (const s of slips) {
    flags.push(
      mk(
        "date",
        `far:${s.e.id}`,
        "medium",
        s.detail,
        "Check the date on the page, especially the month. If the date is right, nothing needs changing; until it sits with the other entries it is left out of the checks that depend on order (missing entries, meter readings, repeats).",
        [s.e],
        { title: "Entry date looks out of place" },
      ),
    );
  }
  const seq: LogEntry[] = [];
  for (const cl of clusters) {
    if (cl === main || cl.length > DATE_OUTLIER_MAX_ENTRIES) {
      for (const e of cl) if (!slipped.has(e)) seq.push(e);
      continue;
    }
    const mainFirst = day.get(main![0]) as number;
    const mainLast = day.get(main![main!.length - 1]) as number;
    for (const e of cl) {
      const n = day.get(e) as number;
      const away = n < mainFirst ? mainFirst - n : n - mainLast;
      flags.push(
        mk(
          "date",
          `far:${e.id}`,
          "medium",
          `An entry is dated ${e.date}, ${away} days away from the rest of the log (${main![0].date} to ${main![main!.length - 1].date}).`,
          "Check the date on the page, especially the year and the month. If the date is right, nothing needs changing; until it sits with the other entries it is left out of the checks that depend on order (missing entries, meter readings, repeats).",
          [e],
          { title: "Entry dated far from the rest of the log" },
        ),
      );
    }
  }
  c.seq = seq;
  for (const k of VARY_KEYS) c.grain.set(k, grainOf(k, valuesOf(seq, k)));
  return { c, flags };
}

// --------------------------------------------------------------- rule: limit

function ruleLimit(c: Ctx): Flag[] {
  const out: Flag[] = [];
  for (const k of PARAM_KEYS) {
    const lim = c.lims[k];
    if (!lim) continue;
    const label = PARAMS[k].label;
    let run: { e: LogEntry; v: number }[] = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0];
      const last = run[run.length - 1];
      const dist = (v: number) => (lim.max !== undefined && v > lim.max ? v - lim.max : (lim.min ?? 0) - v);
      const worst = run.reduce((w, r) => (dist(r.v) > dist(w.v) ? r : w), first);
      const beyond = run.some((r) => !inPhysical(c, k, r.v));
      let detail =
        run.length === 1
          ? `${label} read ${show(k, first.v)} on ${where(c, first.e)}, against a limit of ${limStr(k, lim)}.`
          : `${label} was outside the limit (${limStr(k, lim)}) in ${run.length} readings in a row ${fromTo(c, first.e, last.e)}. Furthest from the limit: ${show(k, worst.v)} on ${where(c, worst.e)}.`;
      if (beyond) {
        detail += ` ${show(k, worst.v)} is also more than a ${c.plant?.kind ?? "treatment"} plant would normally show, so this is either a slip of the pen (a missing decimal point, an extra digit) or a very large exceedance.`;
      }
      const sample = OUTLET_KEYS.includes(k) ? ", and whether the sample was taken at the final outlet" : "";
      out.push(
        mk(
          "limit",
          `${k}:${first.e.id}`,
          "high",
          detail,
          `Check the lab sheet or sample record for ${label} ${fromTo(c, first.e, last.e)}${sample}. If the reading stands, check what the consent order requires.`,
          run.map((r) => r.e),
          { param: k, title: `${label} outside consent limit${beyond ? " (typo or very large exceedance)" : ""}` },
        ),
      );
      run = [];
    };
    let lastDay: number | null = null;
    for (const e of c.all) {
      const v = num(e, k);
      if (v === null || !judged(c, k, v)) continue; // impossible values go to the physical rule
      const d = c.day.get(e) ?? null;
      // "In a row" must not stretch over weeks of blanks.
      if (run.length && (d === null || lastDay === null || Math.abs(d - lastDay) > LIMIT_RUN_MAX_GAP_DAYS)) flush();
      if (outside(lim, v)) {
        run.push({ e, v });
        lastDay = d;
      } else flush();
    }
    flush();
  }
  return out;
}

// ------------------------------------------------------------ rule: physical

// What was written on the page for this cell, when we still have it and nobody
// has corrected the value since; otherwise the number in its shortest form.
function asWritten(e: LogEntry, k: ParamKey, v: number): string {
  const raw = e.cellMeta?.[k]?.raw;
  const edited = Array.isArray(e.edited) && e.edited.includes(k);
  if (typeof raw === "string" && raw.trim() !== "" && !edited) return clip(raw.trim(), 20);
  return shortNum(v);
}

function rulePhysical(c: Ctx): Flag[] {
  const out: Flag[] = [];
  const shiftHours = 24 / c.perDay;

  for (const e of c.all) {
    // A row with no shift letter and no time is the day's row, whatever the
    // plant setting says, and may add the hours of several blowers together.
    const wholeDay = c.daily || (!isShift(e.shift) && clockMin(e.time) === null);
    const blowerMax = wholeDay ? 24 * BLOWER_MAX_UNITS : PARAMS.blowerHours.physicalMax;
    for (const k of PARAM_KEYS) {
      const v = num(e, k);
      if (v === null || inPhysical(c, k, v)) continue;
      if (k === "blowerHours" && v > 0 && v <= blowerMax) continue; // asked about below
      const p = PARAMS[k];
      const written = `${p.label} was recorded as ${asWritten(e, k, v)} on ${where(c, e)}`;
      let detail: string;
      if (v < p.physicalMin && v < 0) {
        detail = `${written}. This reading cannot be negative; a stray dash or a misread mark is likely.`;
      } else if (v > physMax(c, k) && STRENGTH_KEYS.includes(k)) {
        detail = `${written}, above ${shortNum(physMax(c, k))}${unitOf(k)}, which is more than a ${c.plant?.kind ?? "treatment"} plant would normally show. Either a decimal point or digit slipped, or it is a very large exceedance.`;
      } else {
        detail = `${written}, outside the possible range of ${shortNum(p.physicalMin)} to ${shortNum(physMax(c, k))}${unitOf(k)}. A missing decimal point or a misread digit is likely.`;
      }
      out.push(
        mk(
          "physical",
          `${k}:${e.id}`,
          "high",
          detail,
          `Look at the original page for ${p.label} on ${where(c, e)} and correct the entry if it was a handwriting or reading slip.`,
          [e],
          { param: k, title: `${p.label} value cannot be right` },
        ),
      );
    }

    const bod = num(e, "bodOutlet");
    const cod = num(e, "codOutlet");
    if (bod !== null && cod !== null && bod > cod && bod >= 0 && cod >= 0) {
      out.push(
        mk(
          "physical",
          `bod-cod:${e.id}`,
          "high",
          `Outlet BOD (${show("bodOutlet", bod)}) is higher than outlet COD (${show("codOutlet", cod)}) on ${where(c, e)}. BOD cannot exceed COD for the same sample.`,
          `Check the lab sheets for both tests on ${where(c, e)}; one of the two values may be misread, swapped or from a different sample.`,
          [e],
          { param: "bodOutlet", title: "BOD higher than COD" },
        ),
      );
    }

    // A plant with two blowers may add their hours together, so this is a
    // question about how the figure is kept, not an impossible value.
    const bh = num(e, "blowerHours");
    if (bh !== null && bh > (wholeDay ? 24 : shiftHours) && bh <= blowerMax) {
      out.push(
        mk(
          "physical",
          `blower:${e.id}`,
          "medium",
          wholeDay
            ? `Blower run hours of ${show("blowerHours", bh)} on ${where(c, e)} are more than the 24 hours in a day.`
            : `Blower run hours of ${show("blowerHours", bh)} on ${where(c, e)} are more than the ${shiftHours} h in a shift at a ${c.perDay}-shift plant.`,
          wholeDay
            ? "Check whether the figure adds up more than one blower, or was entered in the wrong column. If the plant totals several blowers, this flag can be ignored."
            : "Check whether the figure adds up more than one blower, covers more than one shift, or was entered in the wrong column. If the plant totals several blowers, this flag can be ignored.",
          [e],
          { param: "blowerHours", title: wholeDay ? "Blower hours longer than the day" : "Blower hours longer than the shift" },
        ),
      );
    }
  }

  // What the scale checks below have already reported, so that one slipped
  // figure is one flag.
  const reported = new Map<ParamKey, Set<LogEntry>>();
  const report = (k: ParamKey, es: LogEntry[]) => {
    const s = reported.get(k) ?? new Set<LogEntry>();
    es.forEach((e) => s.add(e));
    reported.set(k, s);
  };
  const listed = (items: string[]) =>
    items.length <= 3 ? items.join("; ") : `${items.slice(0, 3).join("; ")}; and ${items.length - 3} more`;
  const whole = (x: number) => shortNum(Math.round(x));
  const usable = (e: LogEntry, k: ParamKey): number | null => {
    const v = num(e, k);
    return v !== null && inPhysical(c, k, v) ? v : null;
  };

  const byDate = groupBy(
    c.all.filter((e) => c.day.has(e)),
    (e) => e.date,
  );
  const capText = c.capacity === null ? "" : `${shortNum(c.capacity)} KLD (m³ a day)`;
  const capVerify = "If the figures are right, check the design capacity in the plant settings.";

  // ---- volumes against the design capacity. A slipped digit in a flow goes
  // straight into the month's total, so this is worth a look even though a
  // plant can honestly run over its design flow.
  if (c.capacity !== null) {
    const limit = CAPACITY_FLOW_FACTOR * c.capacity;
    for (const k of FLOW_KEYS) {
      const hits: { amount: number; text: string; es: LogEntry[]; date: string }[] = [];
      for (const [date, es] of byDate) {
        const withV = es.filter((e) => usable(e, k) !== null);
        const sum = withV.reduce((s, e) => s + (usable(e, k) as number), 0);
        if (sum > limit) {
          hits.push({ amount: sum, text: `${whole(sum)} m³ on ${fmtDate(c, date)}`, es: withV, date });
          continue;
        }
        // One shift's entry holding more than a third (or half) of that.
        for (const e of withV) {
          const v = usable(e, k) as number;
          const labelled = isShift(e.shift) || clockMin(e.time) !== null;
          if (!c.daily && labelled && v > limit / c.perDay) hits.push({ amount: v, text: `${whole(v)} m³ in one entry on ${where(c, e)}`, es: [e], date });
        }
      }
      if (!hits.length) continue;
      const es = hits.flatMap((h) => h.es);
      report(k, es);
      const worstFirst = [...hits].sort((a, b) => b.amount - a.amount || cmpStr(a.date, b.date));
      out.push(
        mk(
          "physical",
          `capacity:${k}`,
          "high",
          `${PARAMS[k].label} is far above what a plant of this size treats: ${listed(worstFirst.map((h) => h.text))}. The design capacity in the plant settings is ${capText}.`,
          `Check ${PARAMS[k].label} on the page for a slipped digit, a figure from another column, or a meter reading written where a volume belongs. A real surge (storm water, a bypass, tanker loads) is worth a remark. ${capVerify}`,
          es,
          { param: k, title: `${PARAMS[k].label} far above the plant's capacity`, date: hits[0].date },
        ),
      );
    }
    for (const k of Object.keys(CAPACITY_DOSE_KG_PER_M3) as ParamKey[]) {
      const max = (CAPACITY_DOSE_KG_PER_M3[k] as number) * c.capacity;
      const hits = c.all.filter((e) => (usable(e, k) ?? 0) > max);
      if (!hits.length) continue;
      report(k, hits);
      const worst = hits.reduce((w, e) => ((usable(e, k) as number) > (usable(w, k) as number) ? e : w), hits[0]);
      const v = usable(worst, k) as number;
      out.push(
        mk(
          "physical",
          `capacity:${k}`,
          "medium",
          `${PARAMS[k].label} is ${show(k, v)} on ${where(c, worst)}${hits.length > 1 ? `, and too large in the same way on ${hits.length - 1} other ${plural(hits.length - 1, "entry", "entries")}` : ""}. The design capacity in the plant settings is ${capText}, so that is ${shortNum(Number((v / c.capacity).toPrecision(2)))} kg for every m³ the plant can treat in a day.`,
          `Check the unit on the page: grams written in the kilogram column, or a missing decimal point, are the usual causes. ${capVerify}`,
          hits,
          { param: k, title: `${PARAMS[k].label} too large for a plant of this capacity` },
        ),
      );
    }
  }

  // ---- meters: a rise against the capacity, and against the meter's own rises
  for (const k of CUMULATIVE_KEYS) {
    const list = c.seq.filter((e) => usable(e, k) !== null);
    interface Rise {
      e: LogEntry;
      rise: number;
      days: number;
    }
    const rises: Rise[] = [];
    for (let i = 1; i < list.length; i++) {
      const v = usable(list[i], k) as number;
      let base = list[i - 1];
      // A reading that fell and then came back (one misread row): measure the
      // recovery from the row before the fall, not from the misread one.
      if (i >= 2 && (usable(base, k) as number) < (usable(list[i - 2], k) as number) && v >= (usable(list[i - 2], k) as number)) base = list[i - 2];
      const rise = v - (usable(base, k) as number);
      if (rise > 1e-9) rises.push({ e: list[i], rise, days: Math.max(1, (c.day.get(list[i]) as number) - (c.day.get(base) as number)) });
    }
    if (!rises.length) continue;
    const other: ParamKey | null = k === "inletTotaliser" ? "outletTotaliser" : k === "outletTotaliser" ? "inletTotaliser" : null;
    const riseText = (r: Rise) =>
      `a rise of ${shortNum(Number(r.rise.toFixed(3)))}${unitOf(k)} ${r.days > 1 ? `over ${r.days} days ` : ""}to ${fv(k, num(r.e, k))} on ${where(c, r.e)}`;
    // The outlet reading written from the inlet column (or the other way
    // round) is the twin rule's finding, and the fall back is the meter rule's.
    const twin = (r: Rise) => other !== null && num(r.e, other) !== null && same(num(r.e, other) as number, num(r.e, k) as number);
    const noted = (r: Rise) => meterChangeScope(r.e.remarks).includes(k);

    let overCap: Rise[] = [];
    if (c.capacity !== null && FLOW_METERS.includes(k)) {
      const limit = CAPACITY_FLOW_FACTOR * c.capacity;
      overCap = rises.filter((r) => r.rise / r.days > limit && !twin(r) && !noted(r));
      if (overCap.length) {
        report(k, overCap.map((r) => r.e));
        const worstFirst = [...overCap].sort((a, b) => b.rise / b.days - a.rise / a.days);
        out.push(
          mk(
            "physical",
            `capacity:${k}`,
            "high",
            `${PARAMS[k].label} shows far more water than a plant of this size treats: ${listed(worstFirst.map(riseText))}. The design capacity in the plant settings is ${capText}.`,
            `Check the reading on the page for an extra or misread digit, and read the meter on site if the row is recent. If the meter was replaced, say so in the remarks. ${capVerify}`,
            overCap.map((r) => r.e),
            { param: k, title: `${PARAMS[k].label} rises faster than the plant's capacity` },
          ),
        );
      }
    }
    if (rises.length > SCALE_MIN_VALUES) {
      const usual = median(rises.map((r) => r.rise / r.days));
      const jumps = rises.filter((r) => r.rise / r.days >= JUMP_FACTOR * usual && !overCap.includes(r) && !twin(r) && !noted(r));
      if (jumps.length) {
        report(k, jumps.map((r) => r.e));
        const worstFirst = [...jumps].sort((a, b) => b.rise / b.days - a.rise / a.days);
        out.push(
          mk(
            "physical",
            `jump:${k}`,
            "medium",
            `${PARAMS[k].label} jumped far more than it usually does: ${listed(worstFirst.map(riseText))}. Its other rises are around ${shortNum(Number(usual.toPrecision(3)))}${unitOf(k)}.`,
            "Check the reading on the page for an extra or misread digit, and read the meter on site if the row is recent. If the meter was replaced by one with a higher reading, say so in the remarks.",
            jumps.map((r) => r.e),
            { param: k, title: `${PARAMS[k].label} jumped far more than usual` },
          ),
        );
      }
    }
  }

  // ---- a figure far from the column's usual figure: grams for kilograms, an
  // extra digit on a flow
  for (const k of SCALE_KEYS) {
    const list = c.all.filter((e) => usable(e, k) !== null);
    if (list.length <= SCALE_MIN_VALUES) continue;
    const usual = median(list.map((e) => usable(e, k) as number));
    if (!(usual > 0)) continue;
    const factor = FLOW_KEYS.includes(k) ? SCALE_FACTOR_FLOW : SCALE_FACTOR;
    const done = reported.get(k);
    const groups: [string, LogEntry[]][] = [
      ["above", list.filter((e) => (usable(e, k) as number) >= factor * usual && !done?.has(e))],
      ["below", list.filter((e) => (usable(e, k) as number) > 0 && (usable(e, k) as number) * SCALE_FACTOR <= usual && !done?.has(e))],
    ];
    for (const [side, hits] of groups) {
      if (!hits.length) continue;
      const rest = list.length - hits.length;
      const items = hits.map((e) => `${show(k, usable(e, k) as number)} on ${where(c, e)}`);
      out.push(
        mk(
          "physical",
          `scale:${k}:${side}`,
          "medium",
          hits.length === 1
            ? `${PARAMS[k].label} is ${items[0]}; the other ${rest} ${plural(rest, "entry is", "entries are")} around ${show(k, usual)}.`
            : `${PARAMS[k].label} is far ${side} its usual figure on ${hits.length} entries (${listed(items)}); the other ${rest} are around ${show(k, usual)}.`,
          "A unit slip (grams for kilograms), a missing or extra digit, or a figure from another column is likely. Check the page; if the figure is right, a remark saying why helps whoever reads the log next.",
          hits,
          { param: k, title: `${PARAMS[k].label} far from its usual figure` },
        ),
      );
    }
  }

  // Flow balance over a day. Only on days where every expected entry carries
  // both flows: a single shift can honestly discharge more than it received
  // while the equalisation tank drains.
  const gross: { date: string; sumIn: number; sumOut: number; es: LogEntry[] }[] = [];
  for (const [date, es] of byDate) {
    const both = es.filter((e) => num(e, "inletFlow") !== null && num(e, "outletFlow") !== null);
    const partial = es.some((e) => (num(e, "inletFlow") === null) !== (num(e, "outletFlow") === null));
    if (partial || both.length < c.perDay) continue;
    const sumIn = both.reduce((s, e) => s + (num(e, "inletFlow") as number), 0);
    const sumOut = both.reduce((s, e) => s + (num(e, "outletFlow") as number), 0);
    if (sumIn > 0 && sumOut > sumIn * (1 + FLOW_BALANCE_TOLERANCE)) {
      out.push(
        mk(
          "physical",
          `flow-balance:${date}`,
          "medium",
          `Outlet flow for ${fmtDate(c, date)} adds up to ${Math.round(sumOut)} m³ against ${Math.round(sumIn)} m³ at the inlet, ${pct(sumOut / sumIn - 1)} more than came in.`,
          `Compare the inlet and outlet flow meter totals for ${fmtDate(c, date)}. Stored water being drawn down, rainwater or another stream joining after the inlet meter, or a figure in the wrong column would each explain it.`,
          both,
          { param: "outletFlow", title: "Outlet flow higher than inlet flow", date },
        ),
      );
    } else if (sumOut > 0 && sumIn >= FLOW_GROSS_FACTOR * sumOut && !both.some((e) => reported.get("inletFlow")?.has(e))) {
      gross.push({ date, sumIn, sumOut, es: both });
    }
  }
  // The other way round, and only when it is gross. One flag for all such
  // days: a plant that reuses most of its treated water shows this every day.
  if (gross.length) {
    const worstFirst = [...gross].sort((a, b) => b.sumIn / b.sumOut - a.sumIn / a.sumOut || cmpStr(a.date, b.date));
    out.push(
      mk(
        "physical",
        "flow-gross",
        "medium",
        `Inlet flow is several times outlet flow: ${listed(worstFirst.map((g) => `${whole(g.sumIn)} m³ in against ${whole(g.sumOut)} m³ out on ${fmtDate(c, g.date)}`))}.`,
        "Compare the inlet and outlet figures with the page: a slipped digit or a figure in the wrong column would explain it. If the plant stores or reuses most of its treated water before the outlet meter, this can be ignored.",
        gross.flatMap((g) => g.es),
        { param: "inletFlow", title: "Inlet flow far higher than outlet flow", date: gross[0].date },
      ),
    );
  }
  return out;
}

// ------------------------------------------------- rules: repeat and rowcopy

interface Series {
  id: string; // "all" or a shift letter
  entries: LogEntry[];
}

// The whole log in order, plus one series per shift letter so that figures
// copied night after night are seen even though day shifts sit between them.
// A one-entry-a-day plant has no shifts to follow: letters left on its rows
// (the setting was changed, or a page was read as a shift sheet) are ignored.
function seriesOf(c: Ctx): Series[] {
  const out: Series[] = [{ id: "all", entries: c.seq }];
  if (c.daily) return out;
  const byShift = groupBy(
    c.seq.filter((e) => isShift(e.shift)),
    (e) => e.shift as string,
  );
  if (byShift.size >= 2) {
    for (const s of ["A", "B", "C"]) {
      const es = byShift.get(s);
      if (es) out.push({ id: s, entries: es });
    }
  }
  return out;
}

function valuesOf(entries: LogEntry[], k: ParamKey): number[] {
  const out: number[] = [];
  for (const e of entries) {
    const v = num(e, k);
    if (v !== null) out.push(v);
  }
  return out;
}

interface EqualRun {
  entries: LogEntry[];
  from: number; // position of the run among the series' non-blank values
  to: number;
}

// Runs of identical values. One blank cell inside a run does not break it.
function equalRuns(series: LogEntry[], k: ParamKey, minLen: number): EqualRun[] {
  const runs: EqualRun[] = [];
  let cur: LogEntry[] = [];
  let last: number | null = null;
  let blanks = 0;
  let vi = -1; // index of the current non-blank value
  const flush = () => {
    if (cur.length >= minLen) runs.push({ entries: cur, from: vi - cur.length + 1, to: vi });
    cur = [];
    last = null;
  };
  for (const e of series) {
    const v = num(e, k);
    if (v === null) {
      if (++blanks > 1) flush();
      continue;
    }
    blanks = 0;
    if (last !== null && same(last, v)) cur.push(e);
    else {
      flush();
      cur = [e];
    }
    vi++;
    last = v;
  }
  flush();
  return runs;
}

interface RepeatGroup {
  series: string;
  params: ParamKey[];
  entries: LogEntry[]; // every entry in any of the runs, in order
  core: LogEntry[]; // the stretch all of the parameters share
  // False when every parameter in the group is recorded in coarse steps: a pH
  // strip and a comparator kit agreeing with themselves is not several
  // independent readings standing still.
  fine: boolean;
}

function choose(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

function findRepeats(c: Ctx, series: Series[], pAll: Map<ParamKey, number>): RepeatGroup[] {
  interface Cand {
    param: ParamKey;
    entries: LogEntry[];
    lo: number; // position of the first and last entry within the series
    hi: number;
    n: number; // values of this parameter in the series
    p: number;
  }
  const out: RepeatGroup[] = [];
  const covered = new Map<ParamKey, Set<LogEntry>>();
  for (const s of series) {
    const idx = new Map<LogEntry, number>();
    s.entries.forEach((e, i) => idx.set(e, i));
    // One operator's own readings of one parameter, counted once however many
    // of that operator's runs are judged.
    const mine = new Map<string, { st: AgreeStats; at: Map<LogEntry, number> }>();
    const ownReadings = (op: string, k: ParamKey) => {
      const key = `${k}|${op}`;
      let m = mine.get(key);
      if (!m) {
        const es = s.entries.filter((e) => normName(e.operator) === op && num(e, k) !== null);
        const at = new Map<LogEntry, number>();
        es.forEach((e, i) => at.set(e, i));
        m = { st: agreeStats(valuesOf(es, k), c.grain.get(k) ?? FINE), at };
        mine.set(key, m);
      }
      return m;
    };
    const cands: Cand[] = [];
    let tested = 0; // parameters with enough values here to form a run at all
    for (const k of VARY_KEYS) {
      const vals = valuesOf(s.entries, k);
      if (vals.length < REPEAT_MIN_N) continue;
      tested++;
      const runs = equalRuns(s.entries, k, REPEAT_MIN_N);
      if (!runs.length) continue;
      const grain = c.grain.get(k) ?? FINE;
      const st = agreeStats(vals, grain);
      for (const r of runs) {
        const run = r.entries;
        if (s.id === "all") {
          const set = covered.get(k) ?? new Set<LogEntry>();
          run.forEach((e) => set.add(e));
          covered.set(k, set);
        } else if (run.every((e) => covered.get(k)?.has(e))) continue;
        // Judged against the rest of this series. A shift's own series can be
        // stickier than the whole log (night flows look alike) or less so, so
        // take whichever estimate is more forgiving.
        const own = chanceFrom(st, grain, r.from, r.to);
        let p = s.id === "all" ? own : Math.max(pAll.get(k) as number, own);
        // And against the same person's other readings: someone who rounds to
        // the nearest half repeats values far more often than the log as a
        // whole. That habit is the digits rule's business, not a copied run.
        const op = normName(run[0].operator);
        if (op && run.every((e) => normName(e.operator) === op)) {
          const m = ownReadings(op, k);
          const at = m.at.get(run[0]) as number;
          p = Math.max(p, chanceFrom(m.st, grain, at, at + run.length - 1));
        }
        cands.push({ param: k, entries: run, lo: idx.get(run[0]) as number, hi: idx.get(run[run.length - 1]) as number, n: vals.length, p });
      }
    }
    // Parameters repeating over the same stretch are judged together: each
    // alone may be unremarkable, several at once are not. Runs belong together
    // when they share at least REPEAT_MIN_N entries (one of them may run a
    // reading or two longer by coincidence).
    cands.sort((x, y) => x.lo - y.lo || y.hi - x.hi || PARAM_KEYS.indexOf(x.param) - PARAM_KEYS.indexOf(y.param));
    const groups: { members: Cand[]; lo: number; hi: number }[] = [];
    // Groups a later run can still join. Runs arrive in order of where they
    // start, so a group that ends before the next run could share
    // REPEAT_MIN_N entries with it is finished, and is not looked at again.
    let open: { members: Cand[]; lo: number; hi: number }[] = [];
    for (const cand of cands) {
      open = open.filter((x) => x.hi - cand.lo + 1 >= REPEAT_MIN_N);
      const g = open.find((x) => Math.min(x.hi, cand.hi) - Math.max(x.lo, cand.lo) + 1 >= REPEAT_MIN_N);
      if (g) {
        g.members.push(cand);
        g.lo = Math.max(g.lo, cand.lo);
        g.hi = Math.min(g.hi, cand.hi);
      } else {
        const fresh = { members: [cand], lo: cand.lo, hi: cand.hi };
        groups.push(fresh);
        open.push(fresh);
      }
    }
    // Expected number of such coincidences in a log like this one: places a
    // run could start, in every series looked at, for any choice of this many
    // parameters, times the chance of each reading agreeing with the last.
    const places = (n: number, params: number) => series.length * n * choose(tested, params);
    for (const g of groups) {
      if (g.members.length >= 2) {
        // Together, only the stretch they share counts: one long run with a
        // short one somewhere inside it is not a coincidence of both.
        let chance = places(Math.max(...g.members.map((r) => r.n)), g.members.length);
        for (const r of g.members) {
          const inCore = r.entries.filter((e) => (idx.get(e) as number) >= g.lo && (idx.get(e) as number) <= g.hi).length;
          chance *= r.p ** (inCore - 1);
        }
        if (chance < CHANCE_ALPHA) {
          const union = [...new Set(g.members.flatMap((r) => r.entries))].sort((x, y) => (idx.get(x) as number) - (idx.get(y) as number));
          out.push({
            series: s.id,
            params: g.members.map((r) => r.param).sort((x, y) => PARAM_KEYS.indexOf(x) - PARAM_KEYS.indexOf(y)),
            entries: union,
            core: s.entries.slice(g.lo, g.hi + 1),
            fine: g.members.some((r) => !(c.grain.get(r.param) ?? FINE).coarse),
          });
          continue;
        }
      }
      // Otherwise each run has to be remarkable on its own.
      for (const r of g.members) {
        if (!(places(r.n, 1) * r.p ** (r.entries.length - 1) < CHANCE_ALPHA)) continue;
        out.push({ series: s.id, params: [r.param], entries: r.entries, core: r.entries, fine: !(c.grain.get(r.param) ?? FINE).coarse });
      }
    }
  }
  return out;
}

function normName(s: unknown): string {
  return typeof s === "string" ? s.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

function showName(s: unknown): string {
  return typeof s === "string" ? clip(s.trim().replace(/\s+/g, " "), 40) : "";
}

function ruleRepeat(c: Ctx, groups: RepeatGroup[]): Flag[] {
  const out: Flag[] = [];
  for (const g of groups) {
    const { params, entries: es, core } = g;
    const single = params.length === 1;
    // One parameter: its whole run. Several: the stretch they all share.
    const span = single ? es : core;
    const first = span[0];
    const last = span[span.length - 1];
    const n = span.length;
    const names = params.map((k) => PARAMS[k].label).join(", ");
    const sample = params
      .slice(0, 3)
      .map((k) => {
        const e = es.find((x) => num(x, k) !== null) as LogEntry;
        return `${PARAMS[k].short} ${fv(k, num(e, k))}`;
      })
      .join(", ");
    const kind = g.series === "all" ? "" : ` shift ${g.series}`;
    // The flag links every entry in any of the runs; say so when that is more
    // than the stretch the sentence counts.
    const wider =
      es.length > n
        ? ` At least one of them repeats for longer, so ${es.length} entries are linked here (${fromTo(c, es[0], es[es.length - 1]).replace(/^from /, "")}).`
        : "";
    const coarse = g.fine ? "" : ` ${single ? "This reading is" : "All of these are"} recorded in coarse steps here (only a few different values in the whole log), as a paper strip or a comparator kit gives.`;
    const detail = single
      ? `${names} shows exactly the same value (${show(params[0], num(first, params[0]) as number)}) in ${n}${kind} readings in a row ${fromTo(c, first, last)}.${coarse}`
      : `${params.length} parameters (${names}) keep exactly the same values over ${n}${kind} entries in a row ${fromTo(c, first, last)} (for example ${sample}).${wider}${coarse}`;
    out.push(
      mk(
        "repeat",
        `${params.join("+")}:${es[0].id}${g.series === "all" ? "" : ":shift"}`,
        single || !g.fine ? "medium" : "high",
        detail,
        `Check the original measurements for ${dateRange(c, first.date, last.date)}: lab sheets, instrument logs or the handover book. A coarse method (a pH strip, a comparator kit) can honestly give the same figure many times; a reading taken fresh from a meter or the lab rarely does.`,
        es,
        {
          param: single ? params[0] : undefined,
          title: single ? `${PARAMS[params[0]].label} repeated unchanged` : "Several readings repeated unchanged",
        },
      ),
    );
  }
  return out;
}

function ruleRowcopy(c: Ctx, series: Series[], pAll: Map<ParamKey, number>): Flag[] {
  const out: Flag[] = [];
  const covered = new Set<LogEntry>();
  // How often one person's own readings of a parameter agree, worked out once
  // per name. Two rows under the same name are judged by the more forgiving of
  // this and the whole log (see findRepeats).
  const byOp = new Map<string, Map<ParamKey, number>>();
  const opChance = (op: string, k: ParamKey): number => {
    let m = byOp.get(op);
    if (!m) byOp.set(op, (m = new Map()));
    let p = m.get(k);
    if (p === undefined) {
      p = agreeChance(valuesOf(c.seq.filter((e) => normName(e.operator) === op), k), c.grain.get(k) ?? FINE);
      m.set(k, p);
    }
    return p;
  };
  for (const s of series) {
    const es = s.entries;
    let run: LogEntry[] = [];
    let chance = 1;
    let params = 0;
    const flush = () => {
      const copies = run;
      const ch = chance * series.length * Math.max(1, es.length - 1);
      const np = params;
      run = [];
      chance = 1;
      params = 0;
      if (!copies.length || !(ch < CHANCE_ALPHA)) return;
      if (s.id !== "all" && copies.every((e) => covered.has(e))) return;
      copies.forEach((e) => covered.add(e));
      const first = copies[0];
      const last = copies[copies.length - 1];
      const n = copies.length;
      const prevWord = s.id === "all" ? "the entry before" : `the shift ${s.id} entry before`;
      out.push(
        mk(
          "rowcopy",
          `${first.id}${s.id === "all" ? "" : ":shift"}`,
          "high",
          `${n === 1 ? "The entry" : `${n} entries in a row`} ${fromTo(c, first, last)} ${plural(n, "has", "have")} every lab reading (${np} parameters) identical to ${prevWord}.`,
          // The instruments first: the flag is about the readings, not about
          // whoever wrote the row.
          `A probe left reading the same spot, or a lab result carried forward until the next test, can put the same figures in back-to-back rows. Look at the lab sheets and instrument logs for ${dateRange(c, first.date, last.date)} to see which of these readings were taken fresh.`,
          copies,
          { title: plural(n, "Row identical to the previous row", "Rows identical to the previous row") },
        ),
      );
    };
    for (let i = 1; i < es.length; i++) {
      const e = es[i];
      const prev = es[i - 1];
      let count = 0;
      let q = 1;
      let copy = true;
      const op = normName(e.operator);
      const sameOp = op !== "" && op === normName(prev.operator);
      for (const k of LAB_KEYS) {
        const v = num(e, k);
        if (v === null) continue;
        const pv = num(prev, k);
        if (pv === null || !same(v, pv)) {
          copy = false;
          break;
        }
        count++;
        q *= sameOp ? Math.max(pAll.get(k) as number, opChance(op, k)) : (pAll.get(k) as number);
      }
      if (copy && count >= ROWCOPY_MIN_PARAMS) {
        run.push(e);
        chance *= q;
        params = Math.max(params, count);
      } else flush();
    }
    flush();
  }
  return out;
}

// ------------------------------------------------------------- rule: digits

function roundShare(k: ParamKey, vals: number[]): number {
  if (!vals.length) return 0;
  const scale = 10 ** PARAMS[k].decimals;
  const hit = vals.filter((v) => {
    const d = Math.round(Math.abs(v) * scale) % 10;
    return d === 0 || d === 5;
  }).length;
  return hit / vals.length;
}

// Width of the middle 90% of the values, in recording steps.
function spreadSteps(k: ParamKey, vals: number[]): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const lo = s[Math.floor(0.05 * (s.length - 1))];
  const hi = s[Math.ceil(0.95 * (s.length - 1))];
  return (hi - lo) * 10 ** PARAMS[k].decimals;
}

function ruleDigits(c: Ctx, stepFlags: Flag[]): Flag[] {
  const out: Flag[] = [];
  // "Ramesh", "ramesh " and "RAMESH" are one person.
  const byOp = groupBy(
    c.all.filter((e) => normName(e.operator) !== ""),
    (e) => normName(e.operator),
  );
  for (const k of VARY_KEYS) {
    if (DIGITS_SKIP.includes(k)) continue;
    const p = PARAMS[k];
    const digitName = p.decimals === 0 ? "units digit" : "last decimal digit";
    const withVal = c.all.filter((e) => num(e, k) !== null);
    const allVals = valuesOf(withVal, k);
    const overallShare = roundShare(k, allVals);
    const wide = spreadSteps(k, allVals) >= DIGITS_MIN_SPREAD_STEPS - 1e-9;
    // Every single reading on a round step is the method's own resolution (a
    // pH strip reads whole numbers), not a habit worth a flag each month. It
    // is said once, as a note.
    const step = withVal.length >= DIGITS_MIN_VALUES ? roundStep(k, allVals) : null;
    const overall = step !== null || (withVal.length >= DIGITS_MIN_VALUES && overallShare >= DIGITS_ROUND_SHARE && wide);
    // A comparator kit reads 0.2, 0.5 or 1.0 and nothing in between: a handful
    // of values, each well apart from the next. Their last digits say nothing
    // about how the reading was taken either. (A steady meter reading 7.4, 7.5
    // and 7.6 also has few values, but they are neighbours; that is not this.)
    const levels = [...new Set(allVals.map(valueKey))].sort((a, b) => a - b).map((key) => key / 1000);
    const gapSteps = 2 * 10 ** -p.decimals - 1e-9;
    const fixedSteps = levels.length >= 2 && levels.length <= COARSE_MAX_DISTINCT && levels.every((v, i) => i === 0 || v - levels[i - 1] >= gapSteps);
    const few = step === null && withVal.length >= DIGITS_MIN_VALUES && fixedSteps;
    if (few) {
      out.push(
        mk(
          "digits",
          `${k}:all`,
          "low",
          `Only ${levels.length} different values appear in ${withVal.length} ${p.label} readings (${levels.map((v) => fv(k, v)).join(", ")}${unitOf(k)}). A comparator kit or a paper strip gives figures like these; an instrument read as displayed does not.`,
          `Nothing to correct if this is how ${p.label} is measured here. If the plant has an instrument for it, write the reading down as displayed.`,
          withVal,
          { param: k, title: `${p.label} is recorded in a few fixed steps` },
        ),
      );
    } else if (step !== null) {
      const whole = same(step, 1);
      out.push(
        mk(
          "digits",
          `${k}:all`,
          "low",
          `All ${withVal.length} ${p.label} readings are ${whole ? "whole numbers" : `multiples of ${shortNum(step)}${unitOf(k)}`}. A paper strip, a comparator kit or rounding by habit gives figures like these; an instrument read as displayed does not.`,
          `Nothing to correct if this is how ${p.label} is measured here. If the plant has an instrument for it, write the reading down as displayed.`,
          withVal,
          { param: k, title: `${p.label} is recorded in ${whole ? "whole numbers" : `steps of ${shortNum(step)}${unitOf(k)}`}` },
        ),
      );
    } else if (overall) {
      out.push(
        mk(
          "digits",
          `${k}:all`,
          "medium",
          `${pct(overallShare)} of ${withVal.length} ${p.label} readings end in 0 or 5 at the ${digitName} (about 20% is expected if every digit is read as measured).`,
          `Check how ${p.label} is read: the instrument's display resolution, a habit of rounding, or figures taken from a target value. Compare a few entries against the lab sheet or the instrument.`,
          withVal,
          { param: k, title: `${p.label} readings mostly end in 0 or 5` },
        ),
      );
    }
    for (const [op, es] of byOp) {
      if (few) break; // nobody's last digit means anything in such a column
      const mine = es.filter((e) => num(e, k) !== null);
      if (mine.length < DIGITS_MIN_VALUES_OPERATOR) continue;
      const share = roundShare(k, valuesOf(mine, k));
      if (share < DIGITS_ROUND_SHARE) continue;
      // The comparison with everyone else is only stated when it was actually
      // made and came out that way: this flag names a person.
      const mineSet = new Set(mine);
      const others = withVal.filter((e) => !mineSet.has(e));
      const otherShare = roundShare(k, valuesOf(others, k));
      const contrast = others.length >= DIGITS_MIN_VALUES_OPERATOR && otherShare < DIGITS_ROUND_SHARE;
      if (!contrast && overall) continue; // the overall flag already says it
      // Without other readings to compare against, the values must at least
      // range widely enough for the last digit to mean something.
      if (!contrast && spreadSteps(k, valuesOf(mine, k)) < DIGITS_MIN_SPREAD_STEPS - 1e-9) continue;
      const name = showName(es[0].operator);
      out.push(
        mk(
          "digits",
          `${k}:op:${op}`,
          "medium",
          `${pct(share)} of the ${mine.length} ${p.label} readings entered under the operator name ${name} end in 0 or 5 at the ${digitName} (about 20% is expected).${contrast ? ` Among the other ${others.length} readings the share is ${pct(otherShare)}.` : ""}`,
          `Look at how ${p.label} is measured on the ${c.daily ? "days" : "shifts"} covered by these entries: the instrument's resolution, rounding to the nearest 0.5, or a different method from the other ${c.daily ? "days" : "shifts"}.`,
          mine,
          // The name stays out of the title: that is the line a report prints in bold.
          { param: k, title: `${p.label} readings mostly end in 0 or 5 (one operator's entries)` },
        ),
      );
    }
  }

  // Meter readings. The last digit of a meter does not depend on the process,
  // so this needs far fewer readings than a lab value does.
  const meters = CUMULATIVE_KEYS.filter((k) => c.seq.some((e) => num(e, k) !== null)).length;
  for (const k of CUMULATIVE_KEYS) {
    const list = c.seq.filter((e) => {
      const v = num(e, k);
      return v !== null && inPhysical(c, k, v);
    });
    // A reading carried forward unchanged is one reading, not two.
    const read = list.filter((e, i) => i === 0 || !same(num(e, k) as number, num(list[i - 1], k) as number));
    const n = read.length;
    if (n < METER_DIGITS_MIN_VALUES) continue;
    const share = roundShare(k, valuesOf(read, k));
    const hits = Math.round(share * n);
    if (share < DIGITS_ROUND_SHARE || !(meters * binomTail(hits, n, 0.2) < CHANCE_ALPHA)) continue;
    // A meter climbing in identical steps of 5 or 10 ends in 0 or 5 as a
    // consequence; the step flag already says the more specific thing.
    const stepped = new Set(stepFlags.filter((f) => f.param === k).flatMap((f) => f.entryIds));
    if (read.filter((e) => stepped.has(e.id)).length * 2 >= n) continue;
    out.push(
      mk(
        "digits",
        `${k}:meter`,
        "medium",
        `${hits === n ? `All ${n}` : `${hits} of ${n}`} ${PARAMS[k].label} readings end in 0 or 5 (about one in five is expected when a meter is read digit by digit).`,
        "Read the meter on site and compare its last digit with the register. If the meter itself counts in fives or tens, nothing needs correcting; otherwise the readings are being rounded to the nearest 5, or estimated.",
        read,
        { param: k, title: `${PARAMS[k].label} readings mostly end in 0 or 5` },
      ),
    );
  }
  return out;
}

// --------------------------------------------------------------- rule: flat

// Largest share of the values that fits inside any band one step wide.
function bandShare(vals: number[], step: number): number {
  const s = [...vals].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < s.length; hi++) {
    while (s[hi] - s[lo] > step + 1e-9) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return s.length ? best / s.length : 1;
}

// How much inlet flow moves, comparing each shift only with the same shift on
// other days. (Across shifts it always "varies": mornings are busier than nights.)
function sameShiftInletCv(es: LogEntry[]): { cv: number; n: number } | null {
  let sum = 0;
  let n = 0;
  for (const g of groupBy(es, (e) => (isShift(e.shift) ? e.shift : "-")).values()) {
    const vals = valuesOf(g, "inletFlow");
    if (vals.length < 2) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean <= 0) continue;
    for (const v of vals) sum += ((v - mean) / mean) ** 2;
    n += vals.length;
  }
  return n ? { cv: Math.sqrt(sum / n), n } : null;
}

function ruleFlat(c: Ctx, repeats: RepeatGroup[]): Flag[] {
  const out: Flag[] = [];
  const repeatCovered = new Map<ParamKey, Set<LogEntry>>();
  for (const g of repeats) {
    for (const k of g.params) {
      const s = repeatCovered.get(k) ?? new Set<LogEntry>();
      g.entries.forEach((e) => s.add(e));
      repeatCovered.set(k, s);
    }
  }
  for (const k of VARY_KEYS) {
    if (FLAT_SKIP.includes(k)) continue;
    const list = c.seq.filter((e) => num(e, k) !== null);
    if (list.length < FLAT_MIN_LEN) continue;
    const vals = list.map((e) => num(e, k) as number);
    const step = 10 ** -PARAMS[k].decimals;
    let i = 0;
    while (i + FLAT_MIN_LEN <= list.length) {
      let lo = vals[i];
      let hi = vals[i];
      let j = i;
      while (j + 1 < list.length && Math.max(hi, vals[j + 1]) - Math.min(lo, vals[j + 1]) <= step + 1e-9) {
        j++;
        lo = Math.min(lo, vals[j]);
        hi = Math.max(hi, vals[j]);
      }
      const n = j - i + 1;
      if (n < FLAT_MIN_LEN) {
        i++;
        continue;
      }
      const es = list.slice(i, j + 1);
      const rest = [...vals.slice(0, i), ...vals.slice(j + 1)];
      i = j + 1;
      // How often the readings outside this stretch stay inside a band this
      // narrow. With too few of them to tell, assume a fairly steady reading.
      const q = rest.length >= FLAT_MIN_OUTSIDE ? Math.min(FLAT_BAND_CAP, Math.max(AGREE_FLOOR, bandShare(rest, step))) : FLAT_BAND_CAP;
      if (!(list.length * q ** (n - 1) < CHANCE_ALPHA)) continue;
      const cov = repeatCovered.get(k);
      if (cov && es.filter((e) => cov.has(e)).length / n >= FLAT_REPEAT_OVERLAP) continue;
      const inlet = sameShiftInletCv(es);
      if (!inlet || inlet.n < FLAT_INLET_MIN_VALUES || inlet.cv <= FLAT_INLET_CV_MIN) continue;
      out.push(
        mk(
          "flat",
          `${k}:${es[0].id}`,
          n >= FLAT_MEDIUM_LEN ? "medium" : "low",
          `${PARAMS[k].label} stayed between ${show(k, lo)} and ${show(k, hi)} over ${n} readings in a row ${fromTo(c, es[0], es[n - 1])}, while inlet flow for the same ${c.daily ? "days" : "shifts"} varied by about ${pct(inlet.cv)}.`,
          `Check whether ${PARAMS[k].label} is measured each time or carried forward, and look at the lab sheets or the instrument's own trend for ${dateRange(c, es[0].date, es[n - 1].date)}.`,
          es,
          { param: k, title: `${PARAMS[k].label} almost constant while inflow varies` },
        ),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------ rule: missing

interface MissingInfo {
  flags: Flag[];
  expected: number;
  recorded: number;
}

// Which shift a clock time falls in. The night shift wraps past midnight.
function windowIndex(min: number, perDay: 1 | 2 | 3): number {
  if (perDay === 1) return 0;
  if (perDay === 2) return min >= 360 && min < 1080 ? 0 : 1;
  return min >= 360 && min < 840 ? 0 : min >= 840 && min < 1320 ? 1 : 2;
}

function ruleMissing(c: Ctx): MissingInfo {
  const codes = shiftsFor(c.perDay);
  const flags: Flag[] = [];
  let expected = 0;
  let recorded = 0;
  if (!c.seq.length) return { flags, expected, recorded };

  // With no shift letters anywhere, a gap cannot honestly be called "shift C".
  const lettered = !c.daily && c.seq.some((e) => isShift(e.shift) && codes.includes(e.shift));
  // With no clock times either, a row cannot be placed in a shift at all: only
  // the number of rows a day means anything. (A one-row-a-day register opened
  // at a plant set to two or three shifts looks like this.)
  const unplaced = !c.daily && !lettered && !c.seq.some((e) => clockMin(e.time) !== null);

  // Which of a day's expected slots have an entry. Shift letters first, then
  // clock times by the shift they fall in, then anything else (no letter and no
  // time, or a letter this plant does not use) takes whatever slot is left.
  const fill = (es: LogEntry[], fromEnd: boolean): boolean[] => {
    const slots = codes.map(() => false);
    const seen = new Set<string>();
    let spare = 0;
    const timed: number[] = [];
    for (const e of es) {
      if (isShift(e.shift) && codes.includes(e.shift)) {
        slots[codes.indexOf(e.shift)] = true;
        continue;
      }
      const t = clockMin(e.time);
      if (t === null) spare++;
      else if (!seen.has(`${e.shift ?? ""}|${t}`)) {
        seen.add(`${e.shift ?? ""}|${t}`);
        timed.push(t);
      }
    }
    for (const t of timed) {
      const idx = windowIndex(t, c.perDay);
      if (slots[idx]) spare++;
      else slots[idx] = true;
    }
    const orderIdx = slots.map((_, i) => i);
    if (fromEnd) orderIdx.reverse();
    for (const i of orderIdx) {
      if (spare > 0 && !slots[i]) {
        slots[i] = true;
        spare--;
      }
    }
    return slots;
  };

  // Split at long breaks: a break is reported once, not shift by shift.
  const segments: LogEntry[][] = [];
  for (const e of c.seq) {
    const last = segments[segments.length - 1];
    if (last && (c.day.get(e) as number) - (c.day.get(last[last.length - 1]) as number) <= DATE_GAP_DAYS) last.push(e);
    else segments.push([e]);
  }

  // Every slot between the first and the last entry of each segment.
  interface Slot {
    n: number; // day number
    idx: number; // which of the day's expected slots
    ok: boolean;
    filled: number; // how many of that day's slots have an entry
  }
  const perSegment: Slot[][] = segments.map((seg) => {
    const byDay = new Map<number, LogEntry[]>();
    for (const e of seg) {
      const n = c.day.get(e) as number;
      const arr = byDay.get(n);
      if (arr) arr.push(e);
      else byDay.set(n, [e]);
    }
    const startN = c.day.get(seg[0]) as number;
    const endN = c.day.get(seg[seg.length - 1]) as number;
    const slots: Slot[] = [];
    for (let n = startN; n <= endN; n++) {
      // A page that begins part-way through its first day: unlabelled rows are
      // taken to be that day's last shifts, not its first. When no row in the
      // log can be placed, rows simply fill a day's slots from the first, so
      // that every day is counted the same way; a short first day is then
      // allowed for by not expecting more of it than it has.
      const f = fill(byDay.get(n) ?? [], !unplaced && n === startN && n !== endN);
      const filled = f.filter(Boolean).length;
      // Shifts before the first entry and after the last have not been logged
      // yet; they are not missing.
      const from = n === startN ? f.indexOf(true) : 0;
      const to = n === endN || (unplaced && n === startN) ? f.lastIndexOf(true) : f.length - 1;
      for (let idx = from; idx <= to; idx++) slots.push({ n, idx, ok: f[idx], filled });
    }
    return slots;
  });
  const allSlots = perSegment.flat();

  // A slot that is empty on every single day is a setting that does not match
  // the register (a two-shift plant set to three, a daily register set to
  // shifts), not thirty separate gaps. Such slots are not expected at all.
  const dayCount = new Set(allSlots.map((s) => s.n)).size;
  const everOk = codes.map(() => false);
  for (const s of allSlots) if (s.ok) everOk[s.idx] = true;
  const never = codes.map((_, idx) => dayCount >= 3 && !everOk[idx]);
  const neverIdx = never.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  const most = c.perDay - neverIdx.length;
  expected = allSlots.filter((s) => !never[s.idx]).length;
  recorded = allSlots.filter((s) => s.ok).length;
  if (neverIdx.length) {
    flags.push(
      mk(
        "missing",
        "never",
        "medium",
        lettered
          ? `There is no shift ${neverIdx.map((i) => codes[i]).join(" or shift ")} entry on any of the ${dayCount} days in the log, and the plant is set to ${c.perDay} shifts a day.`
          : `No day in the log (${dayCount} days) has more than ${most} ${plural(most, "entry", "entries")}, and the plant is set to ${c.perDay} entries a day.`,
        "If the plant records fewer readings a day than this, change the shifts per day in the plant settings. Otherwise check where the other readings are written down.",
        [],
        { title: "Fewer entries a day than the plant setting", date: dateFromDayNum(allSlots[0].n) },
      ),
    );
  }

  perSegment.forEach((segSlots, si) => {
    const seg = segments[si];
    if (si > 0) {
      const prev = segments[si - 1];
      const a = c.day.get(prev[prev.length - 1]) as number;
      const b = c.day.get(seg[0]) as number;
      flags.push(
        mk(
          "missing",
          `break:${dateFromDayNum(a + 1)}`,
          "medium",
          `There are no entries between ${prev[prev.length - 1].date} and ${seg[0].date}, a break of ${b - a - 1} days.`,
          "Check whether the pages for this period exist and have not been uploaded, or whether the plant was not running. If a group of entries carries the wrong month or year, correct the dates.",
          [],
          { title: "Break in the log", date: dateFromDayNum(a + 1) },
        ),
      );
    }
    // Entries of this segment on or before a day number (the days ascend).
    const segDays = seg.map((e) => c.day.get(e) as number);
    const upTo = (n: number) => {
      let lo = 0;
      let hi = segDays.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (segDays[mid] <= n) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const slots = segSlots.filter((s) => !never[s.idx]);
    let i = 0;
    while (i < slots.length) {
      if (slots[i].ok) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < slots.length && !slots[j + 1].ok) j++;
      const a = slots[i];
      const b = slots[j];
      const count = j - i + 1;
      const aDate = dateFromDayNum(a.n);
      const bDate = dateFromDayNum(b.n);
      let detail: string;
      let range: string;
      let title: string;
      if (c.daily) {
        range = dateRange(c, aDate, bDate);
        detail = count === 1 ? `There is no entry for ${range}.` : `There are no entries for ${count} days, ${range}.`;
        title = plural(count, "Missing day", "Missing days");
      } else if (lettered) {
        const one = (s: Slot) => `${fmtDate(c, dateFromDayNum(s.n))}, shift ${codes[s.idx]}`;
        range = count === 1 ? one(a) : `${one(a)} to ${one(b)}`;
        detail = `${count} expected shift ${plural(count, "entry is", "entries are")} missing: ${range}.`;
        title = plural(count, "Missing shift entry", "Missing shift entries");
      } else {
        // No shift letters in this log: report how many readings each day has.
        const days = new Map<number, number>();
        for (let x = i; x <= j; x++) days.set(slots[x].n, slots[x].filled);
        const list = [...days.entries()]
          .slice(0, 4)
          .map(([n, filled]) => `${fmtDate(c, dateFromDayNum(n))} has ${filled === 0 ? "none" : filled}`)
          .join(", ");
        range = dateRange(c, aDate, bDate);
        const usual = neverIdx.length ? `The other days in the log have ${most} ${plural(most, "entry", "entries")} each` : `This plant is set to ${c.perDay} entries a day`;
        detail = `${count} expected ${plural(count, "entry is", "entries are")} missing on ${range}. ${usual}; ${list}${days.size > 4 ? `, and ${days.size - 4} more ${plural(days.size - 4, "day is", "days are")} short` : ""}.`;
        title = plural(count, "Missing entry", "Missing entries");
      }
      // A week or more with nothing, next to only a handful of entries, is as
      // likely to be those entries carrying the wrong date as a real gap.
      let slip = "";
      if (b.n - a.n + 1 >= DATE_SLIP_GAP_DAYS) {
        const before = upTo(a.n);
        const after = segDays.length - upTo(b.n - 1);
        if (after <= DATE_OUTLIER_MAX_ENTRIES && after < before) {
          slip = ` Only ${after} ${plural(after, "entry follows", "entries follow")} this gap: if ${plural(after, "it carries", "they carry")} the wrong date, correct the date instead.`;
        } else if (before <= DATE_OUTLIER_MAX_ENTRIES && before < after) {
          slip = ` Only ${before} ${plural(before, "entry comes", "entries come")} before this gap: if ${plural(before, "it carries", "they carry")} the wrong date, correct the date instead.`;
        }
      }
      flags.push(
        mk(
          "missing",
          `${aDate}:${codes[a.idx]}`,
          "medium",
          detail,
          (c.daily
            ? `Check the register for ${range}: was the row skipped, written on another page, or was the plant not run?`
            : `Check the logbook for ${range}: was the row skipped, written on another sheet, or the ${lettered ? "shift" : "plant"} not run?`) + slip,
          [],
          { title, date: aDate },
        ),
      );
      i = j + 1;
    }
  });
  return { flags, expected, recorded };
}

// ------------------------------------------------------------ rule: bodfreq

function ruleBodfreq(c: Ctx): Flag[] {
  const byDate = groupBy(
    c.seq.filter((e) => num(e, "bodOutlet") !== null),
    (e) => e.date,
  );
  // Count distinct shifts, not rows: a re-entered row is not a second test.
  const days = [...byDate.entries()].filter(([, es]) => {
    const slots = new Set(es.map((e, i) => (isShift(e.shift) ? e.shift : (clockMin(e.time) ?? `row${i}`))));
    return slots.size >= BODFREQ_MIN_SHIFTS_PER_DAY;
  });
  if (days.length < BODFREQ_MIN_DAYS) return [];
  const es = days.flatMap(([, v]) => v);
  const first = days[0][0];
  const last = days[days.length - 1][0];
  return [
    mk(
      "bodfreq",
      `bodOutlet:${es[0].id}`,
      "medium",
      `Outlet BOD was entered more than once on the same day on ${days.length} days (${dateRange(c, first, last)}). BOD takes 3 days at 27 °C or 5 days at 20 °C to complete, so it cannot be a fresh reading several times a day.`,
      "Ask which test these figures come from: check the BOD incubation records, or whether COD, a field test or an older result was entered in the BOD column.",
      es,
      { param: "bodOutlet", date: first },
    ),
  ];
}

// ---------------------------------------------- rules: meter, step, flowgap

// "meter change", "new meter", "meter badla", "naya meter lagaya", "meter reset".
// The change word has to start a word ("unchanged" is not "changed"), and a
// comma ends the reach ("meter not working, pump changed" is not a meter change).
const METER_CHANGE_RES = [
  /(?:meter|metre|मीटर)[^.,;\n]{0,25}?(?:\b(?:chang|replac|re-?set|badl|badal|new|naya|nayi)|बदल)/gi,
  /(?:\b(?:new|naya|nayi|changed|replaced|reset)|नया)\s+(?:[\w-]+\s+)?(?:meter|metre|मीटर)/gi,
];
// "meter not changed", "no new meter yet", "meter change nahi hua".
const NEGATION_RE = /\b(?:not|no|never|without|nahi|nahin|nhi)\b|n't|नहीं|नही/i;
const NEGATION_REACH = 14; // characters either side of the phrase, within its clause

function mentionsMeterChange(remarks: string): boolean {
  const text = remarks.slice(0, 2000); // a remark is a line or two; cap what is scanned
  for (const re of METER_CHANGE_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const clauseStart = Math.max(text.lastIndexOf(",", m.index), text.lastIndexOf(".", m.index), text.lastIndexOf(";", m.index), text.lastIndexOf("\n", m.index)) + 1;
      const before = text.slice(Math.max(clauseStart, m.index - NEGATION_REACH), m.index);
      const end = m.index + m[0].length;
      const after = text.slice(end, end + NEGATION_REACH).split(/[.,;\n]/)[0];
      if (!NEGATION_RE.test(before) && !NEGATION_RE.test(m[0]) && !NEGATION_RE.test(after)) return true;
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return false;
}

// Which meters a remark about a meter change can refer to.
function meterChangeScope(remarks: unknown): ParamKey[] {
  if (typeof remarks !== "string" || !mentionsMeterChange(remarks)) return [];
  const energy = /energy|kwh|electric|bijli|light|power|unit/i.test(remarks);
  const inlet = /inlet/i.test(remarks);
  const outlet = /outlet/i.test(remarks);
  const flow = inlet || outlet || /flow|water|pani|totali[sz]er/i.test(remarks);
  if (energy && !flow) return ["energyKwh"];
  if (flow && !energy) {
    if (inlet && !outlet) return ["inletTotaliser"];
    if (outlet && !inlet) return ["outletTotaliser"];
    return ["inletTotaliser", "outletTotaliser"];
  }
  return CUMULATIVE_KEYS; // "meter changed": could be any of them
}

// A meter's rises are judged like a finely recorded column, with their own cap.
const STEP_GRAIN: Grain = { coarse: false, cap: STEP_AGREE_CAP, fallback: STEP_AGREE_CAP };

function ranHours(e: LogEntry): number {
  return Math.max(num(e, "blowerHours") ?? 0, num(e, "runHours") ?? 0);
}

function ruleMeter(c: Ctx): Flag[] {
  const out: Flag[] = [];
  const pos = new Map<LogEntry, number>();
  c.seq.forEach((e, i) => pos.set(e, i));
  for (const k of CUMULATIVE_KEYS) {
    const label = PARAMS[k].label;
    let prev: { e: LogEntry; v: number } | null = null;
    const stalls: LogEntry[][] = [];
    const rises: number[] = [];
    let stall: LogEntry[] = [];
    const flushStall = () => {
      if (stall.length) stalls.push(stall);
      stall = [];
    };
    for (const e of c.seq) {
      const v = num(e, k);
      if (v === null) continue;
      if (prev) {
        if (v > prev.v + 1e-9) rises.push(v - prev.v);
        if (v < prev.v - 1e-9) {
          flushStall();
          // The remark may sit on the row of the change, the row before it or
          // the row after it.
          const i = pos.get(e) as number;
          const near = [prev.e, c.seq[i - 1], e, c.seq[i + 1]].filter(Boolean);
          const noted = near.find((x) => meterChangeScope(x.remarks).includes(k));
          const apart = (c.day.get(e) as number) - (c.day.get(prev.e) as number);
          if (!noted && apart > DATE_GAP_DAYS) {
            // Months of the register are not in the log: a meter that was
            // changed or reset in between is likelier than a misreading.
            out.push(
              mk(
                "meter",
                `gap:${k}:${e.id}`,
                "low",
                `${label} was ${fv(k, v)} on ${where(c, e)}, lower than ${fv(k, prev.v)} on ${where(c, prev.e)}, the last entry before a break of ${apart - 1} days in the log.`,
                "Check whether the meter was replaced or reset during the period that is not in the log, and note the old meter's last reading and the new meter's first reading.",
                [prev.e, e],
                { param: k, title: `${label} lower after a break in the log`, date: e.date },
              ),
            );
          } else if (noted) {
            out.push(
              mk(
                "meter",
                `replaced:${k}:${e.id}`,
                "low",
                `${label} fell from ${fv(k, prev.v)} on ${where(c, prev.e)} to ${fv(k, v)} on ${where(c, e)}, and the remarks on ${where(c, noted)} mention a meter change ("${clip(String(noted.remarks).trim(), 80)}"). Treated as a replaced meter.`,
                "Confirm the old meter's last reading and the new meter's first reading and note both in the log, so that totals across the change can be worked out. Keep the old meter in case the reading has to be verified.",
                [prev.e, e],
                { param: k, title: `${label}: meter replaced, confirm old and new readings`, date: e.date },
              ),
            );
          } else {
            out.push(
              mk(
                "meter",
                `down:${k}:${e.id}`,
                "high",
                `${label} was ${fv(k, v)} on ${where(c, e)}, lower than ${fv(k, prev.v)} on ${where(c, prev.e)}. A cumulative meter cannot go down.`,
                `Check the meter against the logbook for ${prev.e.date === e.date ? fmtDate(c, e.date) : `${fmtDate(c, prev.e.date)} and ${fmtDate(c, e.date)}`}: it may be a misread digit, a reading from a different meter, an entry saved under the wrong date, or a meter that was replaced or reset. Either of the two readings may be the wrong one. If the meter was changed, say so in the remarks.`,
                [prev.e, e],
                { param: k, title: `${label} went down`, date: e.date },
              ),
            );
          }
        } else if (same(v, prev.v) && ranHours(e) > 0) {
          stall.push(e);
        } else flushStall();
      }
      prev = { e, v };
    }
    flushStall();
    if (!stalls.length) continue;

    const stalled = stalls.flat();
    const usual = rises.length ? median(rises) : null;
    const step = 10 ** -PARAMS[k].decimals;
    if (stalls.length >= 2 && usual !== null && usual <= COARSE_METER_STEPS * step + 1e-9) {
      // The display is too coarse for one entry's consumption (a meter read
      // without its multiplier, a counter in tens): standing still is normal.
      out.push(
        mk(
          "meter",
          `stall:${k}:coarse`,
          "low",
          `${label} usually moves by only ${shortNum(Number(usual.toFixed(3)))}${unitOf(k)} from one entry to the next, and shows the same figure as the entry before on ${stalled.length} entries where run hours were recorded (first ${fromTo(c, stalls[0][0], stalls[0][stalls[0].length - 1])}).`,
          "A meter read this coarsely cannot show what one entry used. Check whether the display has more digits, or a multiplier (a CT ratio, a x10 counter), that should be written down with the reading.",
          stalled,
          { param: k, title: `${label} moves about one unit per entry` },
        ),
      );
      continue;
    }
    const verify =
      "Read the meter on site and compare it with the logbook: it may be stuck or bypassed, or the reading was carried forward without looking at the meter.";
    if (stalls.length >= STALL_SUMMARY_MIN) {
      const first = stalls[0];
      out.push(
        mk(
          "meter",
          `stall:${k}:many`,
          "medium",
          `${label} showed the same figure as the entry before on ${stalls.length} separate occasions (${stalled.length} entries in all) although run hours were recorded. The first: ${fv(k, num(first[0], k))} ${fromTo(c, first[0], first[first.length - 1])}.`,
          `${verify} A meter read every second or third day and copied in between would look like this too.`,
          stalled,
          { param: k, title: `${label} unchanged while the plant ran` },
        ),
      );
      continue;
    }
    for (const s of stalls) {
      const first = s[0];
      const last = s[s.length - 1];
      out.push(
        mk(
          "meter",
          `stall:${k}:${first.id}`,
          "medium",
          `${label} did not change (${fv(k, num(first, k))}) across ${s.length} ${plural(s.length, "entry", "entries in a row")} ${fromTo(c, first, last)}, although run hours were recorded.`,
          verify,
          s,
          { param: k, title: `${label} unchanged while the plant ran` },
        ),
      );
    }
  }
  return out;
}

function ruleStep(c: Ctx): Flag[] {
  const out: Flag[] = [];
  // How many meters are being looked at: more meters, more chances of a fluke.
  const keys = CUMULATIVE_KEYS.filter((k) => c.seq.some((e) => num(e, k) !== null));
  const meters = keys.length;
  const pos = new Map<LogEntry, number>();
  c.seq.forEach((e, i) => pos.set(e, i));
  const labelOf = (k: ParamKey) => PARAMS[k].label;
  // The outlet column written from the inlet column steps whenever the inlet
  // does. That is one meter's evidence, not two, when meters are judged together.
  const twinOver = (es: LogEntry[]) => {
    const both = es.filter((e) => num(e, "inletTotaliser") !== null && num(e, "outletTotaliser") !== null);
    return both.length > 0 && both.every((e) => same(num(e, "inletTotaliser") as number, num(e, "outletTotaliser") as number));
  };
  const independent = <T extends { k: ParamKey }>(members: T[], over: LogEntry[]): T[] =>
    members.some((m) => m.k === "inletTotaliser") && twinOver(over) ? members.filter((m) => m.k !== "outletTotaliser") : members;
  const alsoNote = (k: ParamKey, mates: ParamKey[]) => {
    const others = mates.filter((x) => x !== k).map(labelOf);
    return others.length ? ` ${others.join(" and ")} ${plural(others.length, "rises", "rise")} in identical steps over the same entries.` : "";
  };

  interface Run {
    k: ParamKey;
    es: LogEntry[];
    before: LogEntry; // the reading the first rise is measured from
    step: number;
    p: number; // chance of one rise agreeing with the rise before it
    n: number; // rises of this meter in the log
    lo: number; // position of the first and last entry in the log
    hi: number;
  }
  interface Column {
    k: ParamKey;
    es: LogEntry[]; // entries whose rise is the common step
    step: number;
    n: number;
    alone: number; // chance of this much agreement in one meter's column
    unbroken: boolean; // every rise in the column is the step
    before: LogEntry;
    last: LogEntry;
    others: string[]; // the rises that are not the step
    acrossGap: number; // rises counted as the step because they are that much per day
  }
  const runs: Run[] = [];
  const columns: Column[] = [];

  for (const k of keys) {
    const list = c.seq.filter((e) => num(e, k) !== null);
    if (list.length <= STEP_MIN_N) continue;
    // rise[i] is how much entry i rose over the reading before it
    const rise: number[] = list.map((e, i) => (i === 0 ? NaN : (num(e, k) as number) - (num(list[i - 1], k) as number)));
    const positive: number[] = [];
    const posAt: number[] = rise.map((r) => (r > 1e-9 ? positive.push(r) - 1 : -1));
    const st = agreeStats(positive);

    // ---- an unbroken run of identical rises, judged against how this meter's
    // other rises vary
    let i = 1;
    while (i < list.length) {
      // Rises of zero belong to the meter rule; falls break a run.
      if (!(rise[i] > 1e-9)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < list.length && same(rise[j + 1], rise[i])) j++;
      if (j - i + 1 >= STEP_MIN_N) {
        runs.push({
          k,
          es: list.slice(i, j + 1),
          before: list[i - 1],
          step: rise[i],
          p: chanceFrom(st, STEP_GRAIN, posAt[i], posAt[j]),
          n: positive.length,
          lo: pos.get(list[i]) as number,
          hi: pos.get(list[j]) as number,
        });
      }
      i = j + 1;
    }

    // ---- the column as a whole: nearly every rise is the same amount. A
    // missing day, a rest day with no rise or one misread digit breaks a run
    // but not this.
    if (positive.length < STEP_MIN_N) continue;
    const tally = new Map<number, { v: number; count: number }>();
    for (const r of positive) {
      const t = tally.get(valueKey(r));
      if (t) t.count++;
      else tally.set(valueKey(r), { v: r, count: 1 });
    }
    const mode = [...tally.values()].reduce((m, t) => (t.count > m.count || (t.count === m.count && t.v < m.v) ? t : m));
    const gapDays = (idx: number) => (c.day.get(list[idx]) as number) - (c.day.get(list[idx - 1]) as number);
    const es: LogEntry[] = [];
    const rest: number[] = [];
    const others: string[] = [];
    let acrossGap = 0;
    for (let x = 1; x < list.length; x++) {
      if (!(rise[x] > 1e-9)) continue;
      const days = gapDays(x);
      // Twice the step over a two-day gap is the same step per day.
      const perDay = days >= 2 && same(rise[x], mode.v * days);
      if (same(rise[x], mode.v) || perDay) {
        es.push(list[x]);
        if (perDay) acrossGap++;
      } else {
        rest.push(rise[x]);
        others.push(`${shortNum(Number(rise[x].toFixed(3)))}${unitOf(k)} on ${where(c, list[x])}`);
      }
    }
    const n = positive.length;
    if (es.length < STEP_MIN_N || es.length < STEP_COLUMN_SHARE * n) continue;
    // The first matching rise sets the value; each of the others had to agree.
    const p = agreeChance(rest, STEP_GRAIN);
    columns.push({
      k,
      es,
      step: mode.v,
      n,
      alone: tally.size * binomTail(es.length - 1, n - 1, p),
      unbroken: es.length === list.length - 1 && acrossGap === 0,
      before: list[list.indexOf(es[0]) - 1],
      last: es[es.length - 1],
      others,
      acrossGap,
    });
  }

  // ---- columns: each on its own, or several meters stepping all the way down
  const verify =
    "Read the meter on site and compare it with the register for a few of these dates. A meter that is read each time rarely climbs in identical steps; a plant run on a timer at a steady load can come close, in which case note that and move on.";
  const colIndep = independent(columns, c.seq);
  const colJoint = colIndep.length >= 2 && choose(meters, colIndep.length) * colIndep.reduce((q, col) => q * col.alone, 1) < CHANCE_ALPHA;
  const stepped = new Map<ParamKey, number>();
  const colFlagged = columns.filter((col) => colJoint || meters * col.alone < CHANCE_ALPHA);
  for (const col of colFlagged) {
    stepped.set(col.k, col.step);
    const { k, es } = col;
    const amount = `${shortNum(Number(col.step.toFixed(3)))}${unitOf(k)}`;
    const span = `(${fv(k, num(col.before, k))} to ${fv(k, num(col.last, k))})`;
    const also = alsoNote(k, colFlagged.map((x) => x.k));
    const detail = col.unbroken
      ? `${labelOf(k)} rose by exactly ${amount} in each of ${es.length} entries in a row ${fromTo(c, es[0], col.last)} ${span}.${also}`
      : `${labelOf(k)} rose by exactly ${amount} in ${es.length} of its ${col.n} rises ${fromTo(c, es[0], col.last)} ${span}.${
          col.acrossGap ? ` ${col.acrossGap} of these ${plural(col.acrossGap, "is a rise", "are rises")} of the same amount per day across days with no entry.` : ""
        }${col.others.length ? ` The other ${plural(col.others.length, "rise", "rises")}: ${col.others.slice(0, 3).join("; ")}${col.others.length > 3 ? `; and ${col.others.length - 3} more` : ""}.` : ""}${also}`;
    out.push(mk("step", `${k}:${es[0].id}`, "medium", detail, verify, es, { param: k, title: `${labelOf(k)} rises in identical steps` }));
  }

  // ---- runs. Meters stepping over the same entries are judged together, as
  // the repeat rule does for parameters: each run alone may be unremarkable.
  const open = runs
    .filter((r) => !(stepped.has(r.k) && same(stepped.get(r.k) as number, r.step)))
    .sort((x, y) => x.lo - y.lo || y.hi - x.hi || PARAM_KEYS.indexOf(x.k) - PARAM_KEYS.indexOf(y.k));
  const groups: { members: Run[]; lo: number; hi: number }[] = [];
  let joinable: { members: Run[]; lo: number; hi: number }[] = [];
  for (const r of open) {
    // Runs arrive in order of where they start: a group that ends too early
    // to share STEP_MIN_N entries with this one cannot be joined by a later one.
    joinable = joinable.filter((x) => x.hi - r.lo + 1 >= STEP_MIN_N);
    const g = joinable.find((x) => !x.members.some((m) => m.k === r.k) && Math.min(x.hi, r.hi) - Math.max(x.lo, r.lo) + 1 >= STEP_MIN_N);
    if (g) {
      g.members.push(r);
      g.lo = Math.max(g.lo, r.lo);
      g.hi = Math.min(g.hi, r.hi);
    } else {
      const fresh = { members: [r], lo: r.lo, hi: r.hi };
      groups.push(fresh);
      joinable.push(fresh);
    }
  }
  for (const g of groups) {
    const core = c.seq.slice(g.lo, g.hi + 1);
    const indep = independent(g.members, core);
    let together = false;
    if (indep.length >= 2) {
      let chance = choose(meters, indep.length) * Math.max(...indep.map((r) => r.n));
      for (const r of indep) {
        const inCore = r.es.filter((e) => (pos.get(e) as number) >= g.lo && (pos.get(e) as number) <= g.hi).length;
        chance *= r.p ** (inCore - 1);
      }
      together = chance < CHANCE_ALPHA;
    }
    for (const r of g.members) {
      const n = r.es.length;
      if (!together && !(meters * r.n * r.p ** (n - 1) < CHANCE_ALPHA)) continue;
      out.push(
        mk(
          "step",
          `${r.k}:${r.es[0].id}`,
          "medium",
          `${labelOf(r.k)} rose by exactly ${shortNum(Number(r.step.toFixed(3)))}${unitOf(r.k)} in each of ${n} entries in a row ${fromTo(c, r.es[0], r.es[n - 1])} (${fv(r.k, num(r.before, r.k))} to ${fv(r.k, num(r.es[n - 1], r.k))}).${together ? alsoNote(r.k, g.members.map((m) => m.k)) : ""}`,
          verify,
          r.es,
          { param: r.k, title: `${labelOf(r.k)} rises in identical steps` },
        ),
      );
    }
  }
  return out;
}

function ruleTwin(c: Ctx): Flag[] {
  const both = c.all.filter((e) => num(e, "inletTotaliser") !== null && num(e, "outletTotaliser") !== null);
  const twins = both.filter((e) => same(num(e, "inletTotaliser") as number, num(e, "outletTotaliser") as number));
  if (twins.length < TWIN_MIN_N) return [];
  const first = twins[0];
  const last = twins[twins.length - 1];
  return [
    mk(
      "twin",
      "totalisers",
      "medium",
      `The inlet and outlet flow meter readings are exactly the same on ${twins.length} of the ${both.length} entries that have both (${dateRange(c, first.date, last.date)}; for example ${fv("inletTotaliser", num(first, "inletTotaliser"))} on ${where(c, first)}).`,
      "Check whether the plant has one flow meter or two. Two separate meters would not be expected to agree to the digit; if there is only one, record it in one column, and if there are two, read the outlet meter itself.",
      twins,
      { param: "outletTotaliser" },
    ),
  ];
}

function ruleFlowgap(c: Ctx): Flag[] {
  const out: Flag[] = [];
  const list = c.seq.filter((e) => num(e, "inletTotaliser") !== null && num(e, "outletTotaliser") !== null);
  let run: { e: LogEntry; dIn: number; dOut: number }[] = [];
  const flush = () => {
    if (run.length >= FLOWGAP_MIN_N) {
      const sumIn = run.reduce((s, r) => s + r.dIn, 0);
      const sumOut = run.reduce((s, r) => s + r.dOut, 0);
      const first = run[0].e;
      const last = run[run.length - 1].e;
      const more = sumIn > 0 ? `, ${pct(sumOut / sumIn - 1)} more than came in` : "";
      out.push(
        mk(
          "flowgap",
          first.id,
          "medium",
          `Over ${run.length} entries in a row ${fromTo(c, first, last)}, the outlet flow meter rose by ${shortNum(sumOut)} m³ while the inlet flow meter rose by ${shortNum(sumIn)} m³${more}.`,
          "Check both meters on site and which column each reading was written in. Stored water being drawn down, another stream joining after the inlet meter, or an inlet meter that is under-reading would each explain it.",
          run.map((r) => r.e),
          { param: "outletTotaliser" },
        ),
      );
    }
    run = [];
  };
  for (let i = 1; i < list.length; i++) {
    const dIn = (num(list[i], "inletTotaliser") as number) - (num(list[i - 1], "inletTotaliser") as number);
    const dOut = (num(list[i], "outletTotaliser") as number) - (num(list[i - 1], "outletTotaliser") as number);
    // A fall in either meter is the meter rule's business, not a flow gap.
    if (dIn >= 0 && dOut > 0 && dOut > dIn * (1 + FLOWGAP_TOLERANCE) + 1e-9) run.push({ e: list[i], dIn, dOut });
    else flush();
  }
  flush();
  return out;
}

// --------------------------------------------------------------- rule: svi

function ruleSvi(c: Ctx): Flag[] {
  const out: Flag[] = [];
  type Hit = { e: LogEntry; svi: number; mlss: number; sv30: number; high: boolean };
  let run: Hit[] = [];
  const flush = () => {
    if (!run.length) return;
    const first = run[0];
    const last = run[run.length - 1];
    const high = first.high;
    // The entry furthest out of range, so the figures quoted belong together.
    const worst = run.reduce((w, r) => ((high ? r.svi > w.svi : r.svi < w.svi) ? r : w), first);
    const many = run.length > 1 ? ` The same holds for ${run.length} entries in a row ${fromTo(c, first.e, last.e)}.` : "";
    const head = `MLSS ${show("mlss", worst.mlss)} with SV30 ${show("sv30", worst.sv30)} on ${where(c, worst.e)} gives an SVI of ${Math.round(worst.svi)} mL/g.`;
    let detail: string;
    let verify: string;
    if (high && worst.sv30 >= SV30_NOT_SETTLED) {
      detail = `${head} The sludge did not settle in 30 minutes: either severe bulking, or a sample too thick for the test without dilution.${many}`;
      verify = `Look at the settling cylinder: if the sludge blanket really stays near the top, treat it as bulking; if the sample is very thick, repeat the SV30 test on a diluted sample. Check both figures against the lab sheet for ${where(c, worst.e)}.`;
    } else if (high) {
      detail = `${head} About 50 to 150 mL/g is the usual working range and above 300 mL/g is severe bulking, so either the sludge is settling very poorly or one of the two readings is off.${many}`;
      verify = `Repeat the MLSS and SV30 tests on a fresh sample and check both against the lab sheet for ${where(c, worst.e)}.`;
    } else {
      detail = `${head} About 50 to 150 mL/g is the usual working range; a value this low more often means the SV30 was read low or the MLSS high than sludge that really settles this fast.${many}`;
      verify = `Repeat the MLSS and SV30 tests on a fresh sample and check both against the lab sheet for ${where(c, worst.e)}.`;
    }
    out.push(mk("svi", first.e.id, "medium", detail, verify, run.map((r) => r.e)));
    run = [];
  };
  for (const e of c.all) {
    const mlss = num(e, "mlss");
    const sv30 = num(e, "sv30");
    if (mlss === null || sv30 === null || mlss <= 0 || sv30 < 0) continue;
    if (!inPhysical(c, "mlss", mlss) || !inPhysical(c, "sv30", sv30)) continue; // the physical rule has these
    const svi = (sv30 * 1000) / mlss;
    if (svi >= SVI_MIN && svi <= SVI_MAX) {
      flush();
      continue;
    }
    const high = svi > SVI_MAX;
    if (run.length && run[0].high !== high) flush();
    run.push({ e, svi, mlss, sv30, high });
  }
  flush();
  return out;
}

// ------------------------------------------------------------ rule: hugging

function ruleHugging(c: Ctx): Flag[] {
  const out: Flag[] = [];
  for (const k of PARAM_KEYS) {
    const lim = c.lims[k];
    const max = lim?.max;
    if (max === undefined || max <= 0) continue;
    // "90% to 100% of the maximum" only means something for a reading that
    // starts at zero. pH is a log scale with a limit on both sides, and 8.1 to
    // 9.0 is most of a plant's working range, not a narrow band under a limit.
    if (lim?.min !== undefined || k === "phOutlet" || k === "phInlet") continue;
    const list = c.all.filter((e) => {
      const v = num(e, k);
      return v !== null && judged(c, k, v);
    });
    if (list.length < HUGGING_MIN_VALUES) continue;
    const band = list.filter((e) => {
      const v = num(e, k) as number;
      return v >= max * HUGGING_BAND_LOW && v <= max;
    });
    const share = band.length / list.length;
    if (share < HUGGING_SHARE) continue;
    out.push(
      mk(
        "hugging",
        k,
        "medium",
        `${band.length} of ${list.length} ${PARAMS[k].label} readings (${pct(share)}) sit between ${fv(k, max * HUGGING_BAND_LOW)} and the limit of ${show(k, max)}. That is a narrow band for results to keep landing in.`,
        `Compare these ${PARAMS[k].label} entries with independent results: an external lab's reports or the regulator's own samples for the same period.`,
        band,
        { param: k, title: `${PARAMS[k].label} readings cluster just under the limit` },
      ),
    );
  }
  return out;
}

// ------------------------------------------------- rules: backfill and ahead

// When an entry reached JalLog, as a day number and a minute of the day in
// Indian time. null for the bundled sample data and unreadable timestamps.
function capturedOn(e: LogEntry): { day: number; minute: number } | null {
  if (e.pageId === "seed" || typeof e.capturedAt !== "string") return null;
  const cap = Date.parse(e.capturedAt);
  if (Number.isNaN(cap)) return null;
  const local = cap + IST_OFFSET_MS;
  const day = Math.floor(local / DAY_MS);
  return { day, minute: Math.floor((local - day * DAY_MS) / 60000) };
}

// How long after its own date an entry reached JalLog. This says when the page
// was photographed, not when the operator wrote it, so it is only ever a note.
function ruleBackfill(c: Ctx): Flag[] {
  const late: { e: LogEntry; capDay: number; lag: number }[] = [];
  for (const e of c.all) {
    const n = c.day.get(e);
    const cap = capturedOn(e);
    if (n === undefined || !cap) continue;
    if (cap.day - n > BACKFILL_DAYS) late.push({ e, capDay: cap.day, lag: cap.day - n });
  }
  const out: Flag[] = [];
  for (const [capDay, ls] of groupBy(late, (l) => String(l.capDay))) {
    const dates = ls.map((l) => l.e.date).sort();
    const lags = ls.map((l) => l.lag);
    const lo = Math.min(...lags);
    const hi = Math.max(...lags);
    const n = ls.length;
    const capDate = dateFromDayNum(+capDay);
    // A register from another year: say which year on both sides.
    const y = capDate.slice(0, 4) !== dates[0].slice(0, 4) || capDate.slice(0, 4) !== dates[n - 1].slice(0, 4);
    const range = dates[0] === dates[n - 1] ? fmtDate(c, dates[0], y) : `${fmtDate(c, dates[0], y)} to ${fmtDate(c, dates[n - 1], y)}`;
    out.push(
      mk(
        "backfill",
        capDate,
        "low",
        `${n} ${plural(n, "entry", "entries")} for ${range} ${plural(n, "was", "were")} digitised on ${fmtDate(c, capDate, y)}, ${lo === hi ? `${lo} days` : `${lo} to ${hi} days`} after the ${plural(n, "date it records", "dates they record")}.`,
        "Nothing to correct in the readings. A page photographed on the day it is filled lets a missed reading or an exceedance show up while it can still be acted on.",
        ls.map((l) => l.e),
        { date: dates[0] },
      ),
    );
  }
  return out;
}

// The other direction: a row dated after the moment its page was photographed.
// The photo's timestamp is the one fact here that the page cannot argue with,
// so either the row was filled in ahead of time or its date (or shift) was
// misread. The flag says both.
function ruleAhead(c: Ctx): Flag[] {
  const early: { e: LogEntry; capDay: number }[] = [];
  for (const e of c.all) {
    const n = c.day.get(e);
    const cap = capturedOn(e);
    if (n === undefined || !cap) continue;
    if (n <= cap.day) continue;
    // Some plants date the night shift by the morning it ends. A shift C row
    // dated tomorrow, photographed after that shift began, is not ahead of anything.
    if (!c.daily && e.shift === "C" && n === cap.day + 1 && cap.minute >= SHIFT_START.C) continue;
    early.push({ e, capDay: cap.day });
  }
  const out: Flag[] = [];
  for (const [capDay, ls] of groupBy(early, (l) => String(l.capDay))) {
    const n = ls.length;
    const capDate = dateFromDayNum(+capDay);
    const first = ls[0].e;
    const last = ls[n - 1].e;
    const y = capDate.slice(0, 4) !== first.date.slice(0, 4) || capDate.slice(0, 4) !== last.date.slice(0, 4);
    out.push(
      mk(
        "ahead",
        capDate,
        "medium",
        `${n} ${plural(n, "entry", "entries")} ${fromTo(c, first, last)} ${plural(n, "was", "were")} digitised on ${fmtDate(c, capDate, y)}, before the ${plural(n, "date it carries", "dates they carry")}.`,
        c.daily
          ? "Check whether these rows were written before the day they are dated, or whether the date was misread from the page. If the date is wrong, correct it."
          : "Check whether these rows were written before the shift, or whether the date was misread from the page. If the date is wrong, correct it.",
        ls.map((l) => l.e),
        { date: first.date },
      ),
    );
  }
  return out;
}

// --------------------------------------------------------------------- main

// Share of judged readings inside their limit. Uses the same values the limit
// rule judges (no impossible values, each entry once), so the two agree.
function complianceRate(c: Ctx): number | null {
  let total = 0;
  let ok = 0;
  for (const k of PARAM_KEYS) {
    const lim = c.lims[k];
    if (!lim) continue;
    for (const e of c.all) {
      const v = num(e, k);
      if (v === null || !judged(c, k, v)) continue;
      total++;
      if (!outside(lim, v)) ok++;
    }
  }
  return total ? ok / total : null;
}

export function runChecks(plant: Plant, entries: LogEntry[]): ChecksResult {
  const { c, flags: prepFlags } = prepare(plant, entries);
  const series = seriesOf(c);
  const pAll = new Map<ParamKey, number>();
  for (const k of VARY_KEYS) {
    pAll.set(k, agreeChance(valuesOf(c.seq, k), c.grain.get(k) ?? FINE));
  }
  const repeats = findRepeats(c, series, pAll);
  const missing = ruleMissing(c);
  const steps = ruleStep(c);

  const flags: Flag[] = [
    ...prepFlags,
    ...ruleLimit(c),
    ...rulePhysical(c),
    ...ruleRepeat(c, repeats),
    ...ruleRowcopy(c, series, pAll),
    ...ruleDigits(c, steps),
    ...ruleFlat(c, repeats),
    ...missing.flags,
    ...ruleBodfreq(c),
    ...ruleMeter(c),
    ...steps,
    ...ruleTwin(c),
    ...ruleFlowgap(c),
    ...ruleSvi(c),
    ...ruleHugging(c),
    ...ruleBackfill(c),
    ...ruleAhead(c),
  ];

  flags.sort(
    (a, b) =>
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      cmpStr(a.date ?? "9999-99-99", b.date ?? "9999-99-99") ||
      cmpStr(a.id, b.id),
  );

  return {
    flags,
    expectedShifts: missing.expected,
    recordedShifts: missing.recorded,
    complianceRate: complianceRate(c),
  };
}
