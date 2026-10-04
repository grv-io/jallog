// Figures for the monthly report and for the overview trends.
//
// Pure functions only: no I/O, no clock, no React, so every number that ends
// up on a printed report can be unit-tested. A saved register is whatever a
// person typed or a model read, so everything here accepts missing, NaN,
// impossible, duplicated and out-of-order input without throwing.

import { DATE_GAP_DAYS, DATE_OUTLIER_MAX_ENTRIES, ETP_STRENGTH_MAX } from "./checks";
import { COLUMN_ORDER, PARAMS } from "./params";
import { PARAM_KEYS } from "./types";
import type { Flag, LogEntry, ParamKey, Plant, ShiftCode } from "./types";

export type Limit = { min?: number; max?: number };

// ------------------------------------------------------------------- basics

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// True only for a real calendar date written as YYYY-MM-DD, in the years the
// rule engine accepts (2000 to 2100). The two must agree: an entry the checks
// call "without a usable date" must not turn up in a month's report.
export function isValidDate(d: unknown): d is string {
  if (typeof d !== "string") return false;
  const m = DATE_RE.exec(d);
  if (!m) return false;
  if (+m[1] < 2000 || +m[1] > 2100) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}

function dayNumber(d: string): number {
  const m = DATE_RE.exec(d)!;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
}

function dateOfDay(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

// "2026-09-07" -> "7 Sep". Anything that is not a date comes back unchanged.
export function shortDate(d: string): string {
  const m = DATE_RE.exec(d ?? "");
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1] ?? m[2]}` : String(d ?? "");
}

export type PlantKind = Plant["kind"] | null | undefined;

// Outlet strengths. Their "physical" maximum is really "more than a plant of
// this kind would show": a value above it is a slip of the pen or a very large
// exceedance, and nobody can tell which from the number alone.
const STRENGTH_KEYS: ReadonlySet<ParamKey> = new Set<ParamKey>(["codOutlet", "bodOutlet", "tssOutlet"]);

// The same two rules as lib/checks.ts (physMax and judged), so that the
// report, the charts and the flags never disagree about one reading. An
// industrial effluent can honestly carry far more COD than treated sewage.
export function physicalMaxFor(kind: PlantKind, k: ParamKey): number {
  return kind === "ETP" && STRENGTH_KEYS.has(k) ? Math.max(PARAMS[k].physicalMax, ETP_STRENGTH_MAX) : PARAMS[k].physicalMax;
}

// A usable reading: a finite number inside what the parameter can physically
// be at this kind of plant. These go into the statistics and onto the charts.
export function isReal(k: ParamKey, v: unknown, kind?: PlantKind): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= PARAMS[k].physicalMin && v <= physicalMaxFor(kind, k);
}

// A reading the limit rule compares with the consent limit: every usable
// reading, plus an outlet strength above its cap. That one is kept out of the
// statistics as a probable slip, but it still counts as outside the limit.
export function isJudged(k: ParamKey, v: unknown, kind?: PlantKind): v is number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < PARAMS[k].physicalMin) return false;
  return v <= physicalMaxFor(kind, k) || STRENGTH_KEYS.has(k);
}

// Something was entered in the cell, usable or not.
function written(v: unknown): boolean {
  return v !== null && v !== undefined;
}

function raw(e: LogEntry, k: ParamKey): unknown {
  const values = e.values as unknown;
  return values && typeof values === "object" ? (values as Record<string, unknown>)[k] : undefined;
}

// ------------------------------------------- values the checks call out of scale

// Per column, the saved entries whose value a check has flagged as out of
// scale: a flow or a dose far above what the plant's capacity allows, a figure
// many times the column's usual one, a meter that jumped by many times its
// usual rise. Each is most often a slipped digit or a wrong unit, and one such
// figure can double a month's total, so the report shows it as written but
// keeps it out of the totals, averages and maxima until a person has looked.
export type SuspectValues = ReadonlyMap<ParamKey, ReadonlySet<string>>;

const SUSPECT_FLAG_IDS = ["physical:capacity:", "physical:scale:", "physical:jump:"];

export function suspectValuesFrom(flags: readonly Flag[] | null | undefined): Map<ParamKey, Set<string>> {
  const out = new Map<ParamKey, Set<string>>();
  for (const f of Array.isArray(flags) ? flags : []) {
    if (!f || typeof f.id !== "string" || !SUSPECT_FLAG_IDS.some((p) => f.id.startsWith(p))) continue;
    if (typeof f.param !== "string" || !(f.param in PARAMS) || !Array.isArray(f.entryIds)) continue;
    const ids = out.get(f.param) ?? new Set<string>();
    for (const id of f.entryIds) if (typeof id === "string") ids.add(id);
    out.set(f.param, ids);
  }
  return out;
}

// A report row may stand for several saved entries (see mergeSlots); it is
// suspect when any of them is named.
function isSuspect(e: LogEntry, ids: ReadonlySet<string> | undefined): boolean {
  if (!ids || ids.size === 0) return false;
  const sources = (e as { sourceIds?: unknown }).sourceIds;
  return Array.isArray(sources) && sources.length > 0 ? sources.some((id) => ids.has(id)) : ids.has(str(e.id));
}

export function readingOf(e: LogEntry, k: ParamKey, kind?: PlantKind): number | null {
  const v = raw(e, k);
  return isReal(k, v, kind) ? v : null;
}

function fmtNum(v: number, maxDecimals = 0): string {
  try {
    return v.toLocaleString("en-IN", { maximumFractionDigits: maxDecimals });
  } catch {
    return String(Number(v.toFixed(maxDecimals)));
  }
}

// Floating-point sums of 0.1 kg doses should not print as 0.30000000000000004.
function tidy(v: number): number {
  return Number(v.toFixed(6));
}

// A limit as saved may carry NaN or text from a half-filled form; keep only
// the sides that are real numbers, and null when neither is.
export function cleanLimit(l: unknown): Limit | null {
  if (!l || typeof l !== "object") return null;
  const { min, max } = l as { min?: unknown; max?: unknown };
  const out: Limit = {};
  if (typeof min === "number" && Number.isFinite(min)) out.min = min;
  if (typeof max === "number" && Number.isFinite(max)) out.max = max;
  return out.min === undefined && out.max === undefined ? null : out;
}

export function limitFor(plant: Pick<Plant, "limits"> | null | undefined, k: ParamKey): Limit | null {
  const limits = plant?.limits as unknown;
  return limits && typeof limits === "object" ? cleanLimit((limits as Record<string, unknown>)[k]) : null;
}

export function isOutside(limit: Limit | null | undefined, v: number | null | undefined): boolean {
  if (!limit || typeof v !== "number" || !Number.isFinite(v)) return false;
  return (limit.max !== undefined && v > limit.max) || (limit.min !== undefined && v < limit.min);
}

export function limitText(limit: Limit | null | undefined): string {
  if (!limit) return "–";
  return [limit.min !== undefined ? `≥ ${limit.min}` : "", limit.max !== undefined ? `≤ ${limit.max}` : ""].filter(Boolean).join(", ") || "–";
}

// Entries a plant makes per day. Anything unexpected is read as three shifts,
// the stricter assumption for "is an entry missing".
export function entriesPerDay(plant: Pick<Plant, "shiftsPerDay"> | null | undefined): 1 | 2 | 3 {
  const n = plant?.shiftsPerDay;
  return n === 1 || n === 2 ? n : 3;
}

const SHIFT_CODES: ShiftCode[] = ["A", "B", "C"];
const SHIFT_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Date, then shift, then clock time, then id. Same order as the rest of the
// app, but safe on entries with a missing date or id.
export function sortLog(entries: readonly LogEntry[] | null | undefined): LogEntry[] {
  const list = Array.isArray(entries) ? entries.filter((e): e is LogEntry => !!e && typeof e === "object") : [];
  return [...list].sort(
    (a, b) =>
      cmp(str(a.date), str(b.date)) ||
      (SHIFT_RANK[str(a.shift)] ?? 3) - (SHIFT_RANK[str(b.shift)] ?? 3) ||
      cmp(str(a.time), str(b.time)) ||
      cmp(str(a.id), str(b.id)),
  );
}

// ------------------------------------------------- one row per register slot

// One row of the register as the report sees it. Normally that is one saved
// entry; it is several when the same date and shift was saved more than once.
export interface SlotRow extends LogEntry {
  sourceIds: string[]; // ids of every saved entry folded into this row
  conflicts: number; // values that differed between those entries
}

export interface MergedLog {
  rows: SlotRow[];
  folded: number; // saved entries folded into another row
  conflicts: number;
}

function contentKey(e: LogEntry): string {
  return PARAM_KEYS.map((k) => (written(raw(e, k)) ? String(raw(e, k)) : "")).join("|");
}

// Folds entries that describe the same register row into one, so nothing is
// counted twice:
//  - the same date and the same shift letter (or clock time) saved again;
//  - at a one-entry-a-day plant, every entry for the same date. A daily
//    register often spans two facing pages (flows on one, dosing on the
//    other) that are photographed separately, and a page can be saved twice;
//  - at a shift plant, rows with no shift or time are folded only when all
//    their values are identical (the same page saved twice). Different rows
//    are kept apart, because there is no telling which shift each one is.
// Where two folded entries disagree on a value, the most recently saved one
// is used and the disagreement is counted so the report can say so.
export function mergeSlots(entries: readonly LogEntry[] | null | undefined, perDay: number): MergedLog {
  const sorted = sortLog(entries);
  const groups = new Map<string, LogEntry[]>();
  sorted.forEach((e, i) => {
    const slot = str(e.shift) || str(e.time);
    let key: string;
    if (!isValidDate(e.date)) key = `?${i}`;
    else if (perDay === 1) key = e.date;
    else if (slot) key = `${e.date}|${slot}`;
    else key = `${e.date}|=${contentKey(e)}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  });

  let folded = 0;
  let conflicts = 0;
  const rows: SlotRow[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      rows.push({ ...g[0], sourceIds: [str(g[0].id)], conflicts: 0 });
      continue;
    }
    // Oldest first, so later saves overwrite earlier ones. The sort is stable.
    const byAge = [...g].sort((a, b) => cmp(str(a.capturedAt), str(b.capturedAt)));
    const latest = byAge[byAge.length - 1];
    const values: LogEntry["values"] = {};
    const cellMeta: NonNullable<LogEntry["cellMeta"]> = {};
    const edited = new Set<ParamKey>();
    const remarks: string[] = [];
    let operator: string | null = null;
    let shift: ShiftCode | null = null;
    let time: string | null = null;
    let rowConflicts = 0;
    for (const e of byAge) {
      for (const k of PARAM_KEYS) {
        const v = raw(e, k);
        if (!written(v)) continue;
        const had = values[k];
        if (written(had) && !Object.is(had, v)) rowConflicts++;
        values[k] = v as number;
        const meta = e.cellMeta?.[k];
        if (meta) cellMeta[k] = meta;
        else delete cellMeta[k];
      }
      if (Array.isArray(e.edited)) e.edited.forEach((k) => edited.add(k));
      const note = str(e.remarks).trim();
      if (note && !remarks.includes(note)) remarks.push(note);
      if (str(e.operator).trim()) operator = e.operator;
      if (e.shift) shift = e.shift;
      if (e.time) time = e.time;
    }
    folded += g.length - 1;
    conflicts += rowConflicts;
    rows.push({
      ...latest,
      shift,
      time,
      operator,
      values,
      cellMeta,
      edited: [...edited],
      remarks: remarks.length ? remarks.join("; ") : null,
      sourceIds: byAge.map((e) => str(e.id)),
      conflicts: rowConflicts,
    });
  }
  return { rows: sortLog(rows) as SlotRow[], folded, conflicts };
}

// ------------------------------------------------------------------- months

// Months ("YYYY-MM") that have at least one entry with a real date, newest
// first. Entries with an unreadable date belong to no month.
export function monthsOf(entries: readonly LogEntry[] | null | undefined): string[] {
  const set = new Set<string>();
  for (const e of sortLog(entries)) if (isValidDate(e.date)) set.add(e.date.slice(0, 7));
  return [...set].sort().reverse();
}

export function undatedCount(entries: readonly LogEntry[] | null | undefined): number {
  return sortLog(entries).filter((e) => !isValidDate(e.date)).length;
}

// -------------------------------------------------------- parameter summary

// Quantities where a monthly total means something (a volume, hours, a mass).
// A total of pH or DO readings would be nonsense.
const ADDITIVE: ReadonlySet<ParamKey> = new Set<ParamKey>([
  "inletFlow", "outletFlow", "blowerHours", "runHours", "limeKg", "alumKg", "chlorineKg", "sludgeKg",
]);

export interface ParamSummary {
  key: ParamKey;
  n: number; // usable readings
  min: number | null;
  mean: number | null;
  max: number | null;
  total: number | null; // only for additive quantities
  limit: Limit | null;
  // Readings outside the limit, counted the way the limit rule counts them
  // (every judged reading). null when there is no limit.
  outside: number | null;
  judged: number; // readings compared with a limit: n + aboveCap
  excluded: number; // entered, but left out of min, average, max and total
  // Of those, outlet strengths above what this kind of plant would show: a
  // probable slip, left out of the statistics but still judged against the limit.
  aboveCap: number;
  // Possible values that a check flagged as out of scale (see SuspectValues).
  // Not in n, min, average, max or total; still compared with a limit if one is set.
  setAside: number;
}

export function summariseParam(
  rows: readonly LogEntry[], k: ParamKey, limit: Limit | null | undefined, kind?: PlantKind, suspect?: ReadonlySet<string>,
): ParamSummary {
  const lim = cleanLimit(limit);
  let n = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let outside = 0;
  let excluded = 0;
  let aboveCap = 0;
  let setAside = 0;
  for (const e of rows ?? []) {
    const v = raw(e, k);
    if (!written(v)) continue;
    if (!isReal(k, v, kind)) {
      excluded++;
      if (isJudged(k, v, kind)) {
        aboveCap++;
        if (isOutside(lim, v)) outside++;
      }
      continue;
    }
    if (isSuspect(e, suspect)) {
      setAside++;
      if (isOutside(lim, v)) outside++;
      continue;
    }
    n++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (isOutside(lim, v)) outside++;
  }
  return {
    key: k,
    n,
    min: n ? min : null,
    mean: n ? sum / n : null,
    max: n ? max : null,
    total: n && ADDITIVE.has(k) ? tidy(sum) : null,
    limit: lim,
    outside: lim ? outside : null,
    judged: n + aboveCap + setAside,
    excluded,
    aboveCap,
    setAside,
  };
}

// ------------------------------------------------- readings against limits

export interface LimitCount {
  key: ParamKey;
  judged: number; // readings compared with the limit
  inside: number;
}

export interface LimitBreakdown {
  params: LimitCount[]; // lowest share inside first
  judged: number;
  inside: number;
  rate: number | null; // inside / judged; null when nothing was judged
}

// "Readings within limits", parameter by parameter. One pooled percentage
// hides the weak parameter: pH is read every shift and is rarely outside, so
// it can carry the figure while most of the lab results fail. The screens
// show the pooled count together with this list, weakest first.
export function limitBreakdown(
  plant: Pick<Plant, "limits" | "kind"> | null | undefined,
  rows: readonly LogEntry[] | null | undefined,
): LimitBreakdown {
  const list = Array.isArray(rows) ? rows.filter((e): e is LogEntry => !!e && typeof e === "object") : [];
  const params: LimitCount[] = [];
  for (const k of COLUMN_ORDER) {
    const lim = limitFor(plant, k);
    if (!lim) continue;
    const s = summariseParam(list, k, lim, plant?.kind);
    if (s.judged > 0) params.push({ key: k, judged: s.judged, inside: s.judged - (s.outside ?? 0) });
  }
  // The sort is stable: ties stay in column order.
  params.sort((a, b) => a.inside / a.judged - b.inside / b.judged);
  const judged = params.reduce((t, p) => t + p.judged, 0);
  const inside = params.reduce((t, p) => t + p.inside, 0);
  return { params, judged, inside, rate: judged ? inside / judged : null };
}

// "TSS 12 of 15, COD 14 of 15": the breakdown as one line of text.
export function limitBreakdownText(b: LimitBreakdown, sep = ", "): string {
  return b.params.map((p) => `${PARAMS[p.key].short} ${p.inside} of ${p.judged}`).join(sep);
}

// ------------------------------------------------------------ meter readings

// "jump": a rise the checks flagged as far too large (see SuspectValues) that
// the readings after it do not take back. Nothing is counted for that step.
export type MeterStatus = "first" | "counted" | "fall" | "outOfSequence" | "jump";

export interface MeterStep {
  index: number; // position of the entry in the list given
  entry: LogEntry;
  value: number;
  // What the meter gained since the previous usable reading. null for the
  // first reading, for a fall, and for a reading that is out of sequence.
  increase: number | null;
  status: MeterStatus;
  since: string | null; // date of the reading the increase is counted from
  base: number | null; // position (index) of the entry that reading is in
  days: number | null; // days between the two readings, when both are dated
}

// How many readings in a row may be set aside as written too high before the
// lower reading after them is treated as a real fall instead (about a week of
// a daily register).
export const MAX_EXCURSION = 7;

// Turns a cumulative meter column into "how much since the last reading".
// A meter only goes up, so the readings that count are the ones that form a
// rising sequence. When a reading is lower than the one before:
//  - if the very next reading is back at or above the earlier level, the low
//    reading is a misread (1,234 / 124 / 1,245) and is left out;
//  - if it still fits above an earlier reading, then the readings in between
//    were written too high (a slipped digit, 12,340 for 1,234; or another
//    column copied in for a few days). They are left out, up to MAX_EXCURSION
//    of them, and the increase is counted across them;
//  - otherwise it is a fall: the meter was replaced or reset. Nothing is
//    counted for that step and counting restarts from the new reading.
// Without this, one slipped digit would add thousands to a monthly total.
// No increase is ever negative.
//
// "suspect" names the entries where a check found the meter rising by far
// more than it can (many times the plant's capacity, or many times its usual
// rise). When the next reading comes back down, the rule above already leaves
// the high one out. When it does not (the last row of the log, or a meter
// swapped for one with a higher reading and no remark), the rise is not
// counted and counting restarts from the new reading, as after a fall.
export function meterSteps(rows: readonly LogEntry[], k: ParamKey, suspect?: ReadonlySet<string>): MeterStep[] {
  const steps: MeterStep[] = [];
  (rows ?? []).forEach((entry, index) => {
    const value = readingOf(entry, k);
    if (value !== null) steps.push({ index, entry, value, increase: null, status: "first", since: null, base: null, days: null });
  });
  // The readings accepted so far since the last fall, oldest first. Their
  // values never decrease.
  let accepted: MeterStep[] = [];
  const count = (step: MeterStep, base: MeterStep) => {
    step.status = "counted";
    step.increase = tidy(step.value - base.value);
    step.since = str(base.entry.date) || null;
    step.base = base.index;
    step.days =
      isValidDate(base.entry.date) && isValidDate(step.entry.date) ? dayNumber(step.entry.date) - dayNumber(base.entry.date) : null;
    accepted.push(step);
  };
  steps.forEach((step, i) => {
    const top = accepted[accepted.length - 1];
    if (!top) {
      accepted = [step];
      return;
    }
    const next = steps[i + 1]?.value;
    if (step.value > top.value && isSuspect(step.entry, suspect) && (next === undefined || next >= step.value)) {
      step.status = "jump";
      accepted = [step];
      return;
    }
    if (step.value >= top.value) return count(step, top);
    if (next !== undefined && next >= top.value) {
      step.status = "outOfSequence";
      return;
    }
    let keep = accepted.length;
    while (keep > 0 && accepted.length - keep < MAX_EXCURSION && accepted[keep - 1].value > step.value) keep--;
    if (keep > 0 && accepted[keep - 1].value <= step.value) {
      for (const high of accepted.splice(keep)) {
        high.status = "outOfSequence";
        high.increase = null;
        high.since = null;
        high.base = null;
        high.days = null;
      }
      return count(step, accepted[accepted.length - 1]);
    }
    step.status = "fall";
    accepted = [step];
  });
  return steps;
}

// A reading from before the month is used as the starting point only when it
// was taken within this many days before the 1st. Further back, the increase
// would mostly belong to the earlier month.
export const MAX_CARRY_DAYS = 3;

export interface MeterMonth {
  key: ParamKey;
  readings: number; // usable readings dated in the month
  first: number | null; // first and last usable reading in the month
  last: number | null;
  total: number | null; // sum of counted increases; null when none could be counted
  from: string | null; // date of the reading the count starts from
  to: string | null; // date of the last reading counted
  carriedIn: boolean; // the count starts from a reading before the month
  falls: number;
  outOfSequence: number;
  jumps: number; // rises flagged as far too large and not counted (see meterSteps)
  excluded: number; // entered but NaN or impossible
  spans: number; // counted increases that cover more than one day
  byDate: Record<string, number>; // counted increase per date
  // An increase that starts at a reading of this month and ends at a reading
  // of a later month, too far from the month end for that month to take it
  // (see MAX_CARRY_DAYS). It is in no month's total, and the notes say so.
  unplaced: { from: string; to: string; amount: number } | null;
}

function meterMonth(dated: readonly LogEntry[], inMonth: readonly LogEntry[], k: ParamKey, month: string, suspect?: ReadonlySet<string>): MeterMonth {
  const monthStart = `${month}-01`;
  const out: MeterMonth = {
    key: k, readings: 0, first: null, last: null, total: null, from: null, to: null,
    carriedIn: false, falls: 0, outOfSequence: 0, jumps: 0, spans: 0, byDate: {}, unplaced: null,
    excluded: inMonth.filter((e) => written(raw(e, k)) && !isReal(k, raw(e, k))).length,
  };
  for (const s of meterSteps(dated, k, suspect)) {
    const date = str(s.entry.date);
    if (date.slice(0, 7) !== month) {
      if (
        s.increase !== null && isValidDate(s.since) && s.since.slice(0, 7) === month && isValidDate(date) && date > s.since &&
        dayNumber(`${date.slice(0, 7)}-01`) - dayNumber(s.since) > MAX_CARRY_DAYS
      ) {
        out.unplaced = { from: s.since, to: date, amount: s.increase };
      }
      continue;
    }
    out.readings++;
    if (s.status !== "outOfSequence") {
      if (out.first === null) out.first = s.value;
      out.last = s.value;
    }
    if (s.status === "fall") out.falls++;
    if (s.status === "jump") out.jumps++;
    if (s.status === "outOfSequence") out.outOfSequence++;
    if (s.increase === null) continue;
    const carried = s.since !== null && s.since < monthStart;
    if (carried && !(isValidDate(s.since) && isValidDate(monthStart) && dayNumber(monthStart) - dayNumber(s.since) <= MAX_CARRY_DAYS)) continue;
    if (carried) out.carriedIn = true;
    if (out.from === null) out.from = s.since;
    out.to = s.entry.date;
    out.total = tidy((out.total ?? 0) + s.increase);
    out.byDate[s.entry.date] = tidy((out.byDate[s.entry.date] ?? 0) + s.increase);
    if (s.days !== null && s.days > 1) out.spans++;
  }
  return out;
}

// ---------------------------------------------------------------- coverage

// "Recorded X of Y expected" has to be the same count on every screen, so the
// rules here are the rule engine's (ruleMissing and the date rule in
// lib/checks.ts), and a test holds the two together:
//  - shifts before the first entry and after the last one have not been
//    logged yet; they are not missing;
//  - a gap of more than DATE_GAP_DAYS days is one break in the log, not
//    hundreds of missing entries;
//  - a few entries dated far from everything else (a mistyped year) are a
//    date to check, not the start of the record.

const TIME_RE = /^\s*(\d{1,2}):(\d{2})/;

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

// Which shift a clock time falls in. The night shift wraps past midnight.
function windowIndex(min: number, perDay: 1 | 2 | 3): number {
  if (perDay === 1) return 0;
  if (perDay === 2) return min >= 360 && min < 1080 ? 0 : 1;
  return min >= 360 && min < 840 ? 0 : min >= 840 && min < 1320 ? 1 : 2;
}

// Which of a day's expected slots have an entry. Shift letters first, then
// clock times by the shift they fall in, then anything else (no letter and no
// time, or a letter this plant does not use) takes whatever slot is left:
// from the end of the day when fromEnd is set, otherwise from its start.
function fillSlots(day: readonly LogEntry[], perDay: 1 | 2 | 3, fromEnd: boolean): boolean[] {
  const codes = SHIFT_CODES.slice(0, perDay) as string[];
  const slots = codes.map(() => false);
  const seen = new Set<string>();
  const timed: number[] = [];
  let spare = 0;
  for (const e of day) {
    const at = codes.indexOf(str(e.shift));
    if (at >= 0) {
      slots[at] = true;
      continue;
    }
    const t = clockMin(e.time);
    if (t === null) spare++;
    else if (!seen.has(`${str(e.shift)}|${t}`)) {
      seen.add(`${str(e.shift)}|${t}`);
      timed.push(t);
    }
  }
  for (const t of timed) {
    const idx = windowIndex(t, perDay);
    if (slots[idx]) spare++;
    else slots[idx] = true;
  }
  const order = slots.map((_, i) => i);
  if (fromEnd) order.reverse();
  for (const i of order) {
    if (spare > 0 && !slots[i]) {
      slots[i] = true;
      spare--;
    }
  }
  return slots;
}

interface PlanDay {
  n: number; // day number
  date: string;
  entries: number; // register rows on the date
  slots: boolean[]; // one per entry the plant makes in a day; true = recorded
  expected: boolean[]; // false = no entry is expected in that slot
  stray: boolean; // dated far from the rest of the log
}

interface SlotPlan {
  days: Map<number, PlanDay>; // every day inside a stretch of the log
  strays: number; // rows dated far from the rest of the log
  breaks: number; // gaps of more than DATE_GAP_DAYS days between stretches
}

// Entries the date rule of the checks has set aside ("dated far from the rest
// of the log"), by entry id. The engine knows more ways a date can be a slip
// than the plain distance rule below, so its verdict is used when there is one.
export function strayIdsFrom(flags: readonly Flag[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const f of Array.isArray(flags) ? flags : []) {
    if (!f || f.ruleId !== "date" || !Array.isArray(f.entryIds)) continue;
    for (const id of f.entryIds) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function isStrayRow(e: LogEntry, strayIds: ReadonlySet<string> | undefined): boolean {
  if (!strayIds || strayIds.size === 0) return false;
  const sources = (e as Partial<SlotRow>).sourceIds;
  return Array.isArray(sources) && sources.length > 0 ? sources.every((id) => strayIds.has(id)) : strayIds.has(str(e.id));
}

type DatedRow = { e: LogEntry; n: number };

function slotPlan(rows: readonly LogEntry[] | null | undefined, perDay: 1 | 2 | 3, strayIds?: ReadonlySet<string>): SlotPlan {
  const dated: DatedRow[] = [];
  const setAside: DatedRow[] = [];
  for (const e of rows ?? []) {
    if (!e || !isValidDate(e.date)) continue;
    (isStrayRow(e, strayIds) ? setAside : dated).push({ e, n: dayNumber(e.date) });
  }
  dated.sort((a, b) => a.n - b.n);

  const stretches: DatedRow[][] = [];
  for (const d of dated) {
    const last = stretches[stretches.length - 1];
    if (last && d.n - last[last.length - 1].n <= DATE_GAP_DAYS) last.push(d);
    else stretches.push([d]);
  }
  const main = stretches.reduce<DatedRow[] | null>((m, s) => (m === null || s.length > m.length ? s : m), null);
  const strayStretches = new Set<DatedRow[]>(stretches.filter((s) => s !== main && s.length <= DATE_OUTLIER_MAX_ENTRIES));
  // Each row the checks set aside is a stretch of its own.
  for (const d of setAside) {
    const alone = [d];
    stretches.push(alone);
    strayStretches.add(alone);
  }

  // With no shift letters and no clock times anywhere in the record, a row
  // cannot be placed in a shift at all: only the number of rows a day means
  // anything. (A one-row-a-day register opened at a plant set to two or three
  // shifts looks like this.) Rows then fill a day's slots from the first.
  const codes = SHIFT_CODES.slice(0, perDay) as string[];
  const unplaced =
    perDay > 1 &&
    !stretches.some((s) => !strayStretches.has(s) && s.some(({ e }) => codes.includes(str(e.shift)) || clockMin(e.time) !== null));

  const plan: SlotPlan = { days: new Map(), strays: 0, breaks: 0 };
  let kept = 0;
  // Strays last, so that a stray day never overwrites a day of the record.
  for (const stretch of [...stretches.filter((s) => !strayStretches.has(s)), ...strayStretches]) {
    const stray = strayStretches.has(stretch);
    if (stray) plan.strays += stretch.length;
    else kept++;
    const byDay = new Map<number, LogEntry[]>();
    for (const { e, n } of stretch) {
      const g = byDay.get(n);
      if (g) g.push(e);
      else byDay.set(n, [e]);
    }
    const startN = stretch[0].n;
    const endN = stretch[stretch.length - 1].n;
    for (let n = startN; n <= endN; n++) {
      const day = byDay.get(n) ?? [];
      // A page that begins part-way through its first day: unlabelled rows
      // are taken to be that day's last shifts, not its first. Where no row
      // can be placed, a short first day is allowed for instead by not
      // expecting more of it than it has.
      const slots = fillSlots(day, perDay, !unplaced && n === startN && n !== endN);
      const from = n === startN ? slots.indexOf(true) : 0;
      const to = n === endN || (unplaced && n === startN) ? slots.lastIndexOf(true) : slots.length - 1;
      if (stray && plan.days.has(n)) continue; // the record already has this day
      plan.days.set(n, { n, date: dateOfDay(n), entries: day.length, slots, expected: slots.map((_, i) => i >= from && i <= to), stray });
    }
  }
  plan.breaks = Math.max(0, kept - 1);

  // A slot that is empty on every single day is a setting that does not match
  // the register (a two-shift plant set to three), not a gap on each day. The
  // checks report it once; here that slot is simply not expected.
  const record = [...plan.days.values()].filter((d) => !d.stray);
  if (perDay > 1 && record.length >= 3) {
    for (let idx = 0; idx < perDay; idx++) {
      if (record.some((d) => d.slots[idx])) continue;
      for (const d of record) d.expected[idx] = false;
    }
  }
  return plan;
}

const countTrue = (list: readonly boolean[]) => list.reduce((n, v) => n + (v ? 1 : 0), 0);

export interface DayCoverage {
  date: string;
  entries: number;
  slots: boolean[]; // one per entry the plant makes in a day; true = recorded
  // false where no entry is expected: a shift before the first entry or after
  // the latest one, a day inside a long break, a far-off date. Such a slot is
  // drawn neutral, never as "no entry".
  expected: boolean[];
}

export interface Coverage {
  days: DayCoverage[]; // every date from the first to the last entry (or the latest maxDays of them)
  recorded: number;
  expected: number;
  firstDate: string | null;
  lastDate: string | null;
  totalDays: number;
  truncated: boolean; // days holds only the latest maxDays
  strays: number; // rows left out because they are dated far from the rest
  breaks: number; // long breaks inside the span; their days are not counted as missing
}

export function coverage(
  rows: readonly LogEntry[] | null | undefined,
  perDay: 1 | 2 | 3,
  maxDays = 400,
  strayIds?: ReadonlySet<string>, // see strayIdsFrom
): Coverage {
  const plan = slotPlan(rows, perDay, strayIds);
  const kept = [...plan.days.values()].filter((d) => !d.stray);
  if (!kept.length) {
    return { days: [], recorded: 0, expected: 0, firstDate: null, lastDate: null, totalDays: 0, truncated: false, strays: plan.strays, breaks: 0 };
  }
  let first = Infinity;
  let last = -Infinity;
  let recorded = 0;
  let expected = 0;
  for (const d of kept) {
    if (d.n < first) first = d.n;
    if (d.n > last) last = d.n;
    recorded += countTrue(d.slots);
    expected += countTrue(d.expected);
  }
  const totalDays = last - first + 1;
  const shown = Math.max(1, Math.min(totalDays, Math.floor(maxDays) || 1));
  const days: DayCoverage[] = [];
  for (let n = last - shown + 1; n <= last; n++) {
    const d = plan.days.get(n);
    const none = Array.from({ length: perDay }, () => false);
    if (!d) days.push({ date: dateOfDay(n), entries: 0, slots: none, expected: none });
    else days.push({ date: d.date, entries: d.entries, slots: d.slots, expected: d.stray ? none : d.expected });
  }
  return {
    days, recorded, expected,
    firstDate: dateOfDay(first), lastDate: dateOfDay(last), totalDays, truncated: shown < totalDays,
    strays: plan.strays, breaks: plan.breaks,
  };
}

// Where each row sits on the register's own time line, counted in entry
// slots: day number x entries per day + the slot within the day. null for a
// row with no usable date. Used to tell an increase between two consecutive
// entries from one that runs across missing entries.
function slotPositions(rows: readonly LogEntry[], perDay: 1 | 2 | 3): (number | null)[] {
  const codes = SHIFT_CODES.slice(0, perDay) as string[];
  const unlabelled = new Map<string, number>();
  return rows.map((e) => {
    if (!e || !isValidDate(e.date)) return null;
    let idx = perDay === 1 ? 0 : codes.indexOf(str(e.shift));
    if (idx < 0) {
      const t = clockMin(e.time);
      if (t !== null) idx = windowIndex(t, perDay);
      else {
        // No shift letter and no time: the rows of the day in the order given.
        const seen = unlabelled.get(e.date) ?? 0;
        unlabelled.set(e.date, seen + 1);
        idx = Math.min(seen, perDay - 1);
      }
    }
    return dayNumber(e.date) * perDay + idx;
  });
}

// ------------------------------------------------------ average daily volume

export interface DailyVolume {
  perDay: number; // m³ a day
  days: number; // days the counted increases cover (may be fractional at a shift plant)
  total: number; // m³ counted
}

// Average volume per day from a totaliser. Every counted increase goes in,
// and the divisor is the time those increases cover, so a meter read every
// shift gives the same daily figure as one read once a day. A step where the
// meter fell adds neither volume nor time. null when the readings cover less
// than one day: a single shift is not a daily average. A rise the checks
// flagged as far too large (see meterSteps) adds neither, like a fall.
export function averageDailyVolume(
  rows: readonly LogEntry[] | null | undefined,
  k: ParamKey,
  perDay: 1 | 2 | 3,
  suspect?: SuspectValues,
): DailyVolume | null {
  const list = Array.isArray(rows) ? rows.filter((e): e is LogEntry => !!e && typeof e === "object") : [];
  const pos = slotPositions(list, perDay);
  let total = 0;
  let slots = 0;
  for (const s of meterSteps(list, k, suspect?.get(k))) {
    if (s.increase === null || s.base === null) continue;
    const a = pos[s.base];
    const b = pos[s.index];
    if (a === null || b === null || b < a) continue;
    total += s.increase;
    slots += b - a;
  }
  const days = slots / perDay;
  if (!(days >= 1)) return null;
  return { perDay: total / days, days: tidy(days), total: tidy(total) };
}

// ------------------------------------------------------------ monthly report

export type DailyAgg = "sum" | "mean" | "max" | "last" | "increase";

export interface DailyColumn {
  id: string;
  param: ParamKey;
  agg: DailyAgg;
  label: string;
  sub: string; // second heading line: how the day's figure is made, and the unit
  decimals: number;
  hasTotal: boolean; // a month total makes sense for this column
}

const DAILY_COLUMNS: { id: string; param: ParamKey; agg: DailyAgg; label: string; unit?: string }[] = [
  { id: "inflow", param: "inletFlow", agg: "sum", label: "Inlet" },
  { id: "outflow", param: "outletFlow", agg: "sum", label: "Outlet" },
  { id: "inMeter", param: "inletTotaliser", agg: "last", label: "Inlet meter", unit: "reading" },
  { id: "inVolume", param: "inletTotaliser", agg: "increase", label: "Inlet volume" },
  { id: "outMeter", param: "outletTotaliser", agg: "last", label: "Outlet meter", unit: "reading" },
  { id: "outVolume", param: "outletTotaliser", agg: "increase", label: "Outlet volume" },
  { id: "runHours", param: "runHours", agg: "sum", label: "Run" },
  { id: "ph", param: "phOutlet", agg: "mean", label: "pH out" },
  { id: "do", param: "doAeration", agg: "mean", label: "DO" },
  { id: "mlss", param: "mlss", agg: "mean", label: "MLSS" },
  { id: "cod", param: "codOutlet", agg: "max", label: "COD" },
  { id: "bod", param: "bodOutlet", agg: "max", label: "BOD" },
  { id: "tss", param: "tssOutlet", agg: "max", label: "TSS" },
  { id: "cl", param: "residualChlorine", agg: "mean", label: "Cl₂" },
  { id: "blower", param: "blowerHours", agg: "sum", label: "Blower" },
  { id: "lime", param: "limeKg", agg: "sum", label: "Lime" },
  { id: "alum", param: "alumKg", agg: "sum", label: "Alum" },
  { id: "chlorine", param: "chlorineKg", agg: "sum", label: "Cl dose" },
  { id: "sludge", param: "sludgeKg", agg: "sum", label: "Sludge" },
  { id: "energyMeter", param: "energyKwh", agg: "last", label: "Energy meter", unit: "reading" },
  { id: "energyUsed", param: "energyKwh", agg: "increase", label: "Energy used" },
];

export interface DailyRow {
  date: string;
  entries: number; // register rows found for the date
  recorded: number; // of the day's expected entries, how many are on record
  expected: number; // entries expected that day (fewer on the first and last day of a record)
  cells: Record<string, number | null>; // by column id
  outside: string[]; // column ids where a reading that day was outside its limit
  // Column ids whose figure is a day's total made from fewer entries than the
  // plant makes in a day, so it is lower than the day's real total.
  partial: string[];
  // Column ids whose figure that day holds a value the checks flagged as out
  // of scale. It is shown as written and left out of the month's figures.
  setAside: string[];
}

export interface VolumeFigure {
  value: number;
  source: "meter" | "entries"; // from totaliser differences, or summed per-entry volumes
}

export interface MonthReport {
  month: string;
  perDay: 1 | 2 | 3;
  rows: SlotRow[]; // the month's register rows, in order
  firstDate: string | null; // first and last date with an entry in the month
  lastDate: string | null;
  // Counted with the rule engine's rules over the whole log (see slotPlan), so
  // days with no entry at either end of the month are expected when the
  // record runs on into the next month or began in an earlier one.
  recorded: number;
  expected: number;
  daysRecorded: number; // dates in the month that have an entry
  daysInMonth: number; // calendar days of the month; 0 for a month that is not one
  // Register rows that are generated sample data (see buildReport's options).
  generated: number;
  summaries: ParamSummary[]; // measured and dosed quantities that have any entry
  meters: MeterMonth[]; // cumulative meters that have any entry
  columns: DailyColumn[]; // only columns with data
  daily: DailyRow[]; // every date from the first to the last entry of the month
  totals: Record<string, number | null>; // month totals for columns where hasTotal
  inflow: VolumeFigure | null;
  outflow: VolumeFigure | null;
  energyUsed: number | null; // kWh, never negative
  // Values read from a photographed page that a person then changed (at the
  // review step or later in the Log). See changedFromPage.
  corrected: number;
  excluded: number; // values entered but left out of the statistics
  aboveCap: number; // of those, outlet strengths above the cap that are still judged against the limit
  setAside: number; // possible values flagged as out of scale, left out of the statistics and totals
  folded: number; // saved entries folded into another row of the same date and shift
  conflicts: number; // values that differed between folded entries
  remarks: { id: string; date: string; shift: ShiftCode | null; text: string }[];
}

// The day's figure for one column. The daily record shows what the limit rule
// judges, so an outlet strength above its cap appears here (shaded, and listed
// under the exceedances) even though the statistics leave it out.
function aggregate(day: readonly LogEntry[], k: ParamKey, agg: DailyAgg, kind: PlantKind): number | null {
  const vals: number[] = [];
  for (const e of day) {
    const v = raw(e, k);
    if (isJudged(k, v, kind)) vals.push(v);
  }
  if (!vals.length) return null;
  if (agg === "sum") return tidy(vals.reduce((s, v) => s + v, 0));
  if (agg === "mean") return vals.reduce((s, v) => s + v, 0) / vals.length;
  if (agg === "max") return vals.reduce((m, v) => (v > m ? v : m), -Infinity);
  return vals[vals.length - 1]; // "last": the day's closing meter reading
}

// Calendar days in "YYYY-MM"; 0 when that is not a month.
function daysInMonth(month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!m || +m[2] < 1 || +m[2] > 12) return 0;
  return new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
}

// The first number written in a cell, as the page gave it. Only for telling
// "retyped the same value" from "changed the value"; null when the text has
// no plain number in it (two clock times, a ditto mark).
function writtenNumber(text: string): number | null {
  // "9:00 - 17:00", "9 am - 3 pm": run hours written as two clock times.
  if (/\d\s*:\s*\d{2}/.test(text) || /\d\s*[ap]\.?\s?m\b/i.test(text) || /\d\s*(?:-|–|to)\s*\d/i.test(text)) return null;
  const m = /\d+(?:[.,]\d+)*/.exec(text);
  if (!m) return null;
  const token = m[0];
  const parts = token.split(",");
  // "7,4" is a decimal comma; "1,250" and "1,25,000" group digits.
  const plain = parts.length === 2 && parts[1].length <= 2 && !parts[1].includes(".") ? `${parts[0]}.${parts[1]}` : parts.join("");
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

// True when a cell that came from a photographed page now holds a value other
// than the one first read from the page. The "edited" mark alone is not
// enough: the review screen sets it on any keystroke, so retyping the same
// number sets it too. Grams on the page are stored as kilograms, so a cell
// that reads "500 g" and holds 0.5 is unchanged. Where the first reading
// cannot be rebuilt from the text (start and close times, a ditto mark), the
// mark is taken at its word.
function changedFromPage(e: LogEntry, k: ParamKey): boolean {
  const v = raw(e, k);
  const meta = e.cellMeta && typeof e.cellMeta === "object" ? e.cellMeta[k] : undefined;
  const text = meta && typeof meta.raw === "string" ? meta.raw : "";
  if (!text.trim()) return typeof v === "number"; // nothing was read; a person typed a value in
  if (typeof v !== "number" || !Number.isFinite(v)) return true; // a read value was cleared
  const first = writtenNumber(text);
  if (first === null) return true;
  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  return !(same(v, first) || (PARAMS[k].unit === "kg" && same(v, first / 1000)));
}

export interface ReportOptions {
  // Tells whether a saved entry is generated sample data rather than something
  // read from a register. Defaults to "it belongs to a bundled sample history".
  isGenerated?: (e: LogEntry) => boolean;
  // Entries the checks set aside as dated far from the rest (see strayIdsFrom).
  strayIds?: ReadonlySet<string>;
  // Values the checks flagged as out of scale (see suspectValuesFrom).
  suspect?: SuspectValues;
}

const fromSeed = (e: LogEntry) => e.pageId === "seed";

export function buildReport(
  plant: Pick<Plant, "limits" | "shiftsPerDay"> & { kind?: Plant["kind"] } | null | undefined,
  entries: readonly LogEntry[] | null | undefined,
  month: string,
  opts: ReportOptions = {},
): MonthReport {
  const perDay = entriesPerDay(plant);
  const kind = plant?.kind;
  const merged = mergeSlots(entries, perDay);
  const dated = merged.rows.filter((e) => isValidDate(e.date));
  const rows = dated.filter((e) => e.date.slice(0, 7) === month);
  // The plan is made from the whole log: whether the days after the month's
  // last entry are missing depends on whether the record goes on afterwards.
  const plan = slotPlan(dated, perDay, opts.strayIds);
  const planDays = [...plan.days.values()].filter((d) => d.date.slice(0, 7) === month).sort((a, b) => a.n - b.n);

  const present = PARAM_KEYS.filter((k) => rows.some((e) => written(raw(e, k))));
  const suspect = opts.suspect instanceof Map ? opts.suspect : undefined;
  const summaries = present
    .filter((k) => PARAMS[k].kind === "reading")
    .map((k) => summariseParam(rows, k, limitFor(plant, k), kind, suspect?.get(k)));
  const meters = present.filter((k) => PARAMS[k].kind === "cumulative").map((k) => meterMonth(dated, rows, k, month, suspect?.get(k)));
  const meterOf = (k: ParamKey) => meters.find((m) => m.key === k);
  const totalOf = (k: ParamKey) => summaries.find((s) => s.key === k)?.total ?? null;

  const byDate = new Map<string, SlotRow[]>();
  for (const e of rows) {
    const g = byDate.get(e.date);
    if (g) g.push(e);
    else byDate.set(e.date, [e]);
  }

  const sums: Record<string, number> = {}; // month totals of the "sum" columns
  const daily: DailyRow[] = planDays.map((p) => {
    const date = p.date;
    const day = byDate.get(date) ?? [];
    const recorded = countTrue(p.slots);
    const cells: Record<string, number | null> = {};
    const outside: string[] = [];
    const partial: string[] = [];
    const setAside: string[] = [];
    for (const c of DAILY_COLUMNS) {
      cells[c.id] = c.agg === "increase" ? (meterOf(c.param)?.byDate[date] ?? null) : aggregate(day, c.param, c.agg, kind);
      // The day's figure stays as written. What goes into the month total is
      // the same figure without the flagged values, so that the total row
      // agrees with the parameter summary.
      const ids = suspect?.get(c.param);
      const flagged = c.agg !== "increase" && cells[c.id] !== null && day.some((e) => isSuspect(e, ids) && isJudged(c.param, raw(e, c.param), kind));
      if (flagged) setAside.push(c.id);
      if (c.agg === "sum") {
        const kept = flagged ? aggregate(day.filter((e) => !isSuspect(e, ids)), c.param, c.agg, kind) : cells[c.id];
        if (kept !== null) sums[c.id] = tidy((sums[c.id] ?? 0) + kept);
      }
      const lim = PARAMS[c.param].kind === "reading" ? limitFor(plant, c.param) : null;
      // An average can sit inside the limit while one reading of the day did
      // not, so the cell is marked from the readings, not from the average.
      if (lim && day.some((e) => isJudged(c.param, raw(e, c.param), kind) && isOutside(lim, raw(e, c.param) as number))) outside.push(c.id);
      if (c.agg === "sum" && cells[c.id] !== null && recorded < perDay) partial.push(c.id);
    }
    return { date, entries: day.length, recorded, expected: countTrue(p.expected), cells, outside, partial, setAside };
  });

  const columns: DailyColumn[] = DAILY_COLUMNS.filter((c) => daily.some((d) => d.cells[c.id] !== null)).map((c) => {
    const unit = c.unit ?? PARAMS[c.param].unit;
    // "avg" and "max" only mean something when a day has several entries.
    const how = perDay > 1 && c.agg === "mean" ? "avg" : perDay > 1 && c.agg === "max" ? "max" : "";
    return {
      id: c.id, param: c.param, agg: c.agg, label: c.label,
      sub: [how, unit].filter(Boolean).join(" "),
      decimals: c.agg === "sum" && (c.param === "inletFlow" || c.param === "outletFlow") ? 0 : PARAMS[c.param].decimals,
      hasTotal: c.agg === "sum" || c.agg === "increase",
    };
  });

  const totals: Record<string, number | null> = {};
  for (const c of columns) {
    if (!c.hasTotal) continue;
    if (c.agg === "sum") {
      totals[c.id] = sums[c.id] ?? null;
      continue;
    }
    const vals = daily.map((d) => d.cells[c.id]).filter((v): v is number => v !== null);
    totals[c.id] = vals.length ? tidy(vals.reduce((s, v) => s + v, 0)) : null;
  }

  const volume = (meter: ParamKey, perEntry: ParamKey): VolumeFigure | null => {
    const m = meterOf(meter)?.total;
    if (m !== null && m !== undefined) return { value: m, source: "meter" };
    const t = totalOf(perEntry);
    return t !== null ? { value: t, source: "entries" } : null;
  };

  // Corrections are counted on the saved entries themselves: a folded row
  // carries the marks of every entry in it, whichever page each came from.
  const inMonth = new Set(rows.flatMap((e) => e.sourceIds));
  const isGenerated = opts.isGenerated ?? fromSeed;
  const generatedIds = new Set<string>();
  let corrected = 0;
  for (const e of sortLog(entries)) {
    if (!inMonth.has(str(e.id))) continue;
    let generated = false;
    try {
      generated = isGenerated(e) === true;
    } catch {
      generated = false;
    }
    if (generated) generatedIds.add(str(e.id));
    // Only a value that was read from a photographed page can have been
    // "corrected at review": not one typed in by hand, not sample history.
    if (generated || typeof e.pageId !== "string" || e.pageId === "" || e.pageId === "seed") continue;
    if (Array.isArray(e.edited)) corrected += PARAM_KEYS.filter((k) => e.edited!.includes(k) && changedFromPage(e, k)).length;
  }

  const entryDates = [...byDate.keys()].sort();

  return {
    month,
    perDay,
    rows,
    firstDate: entryDates[0] ?? null,
    lastDate: entryDates[entryDates.length - 1] ?? null,
    recorded: daily.reduce((n, d) => n + d.recorded, 0),
    expected: daily.reduce((n, d) => n + d.expected, 0),
    daysRecorded: entryDates.length,
    daysInMonth: daysInMonth(month),
    generated: rows.filter((e) => e.sourceIds.length > 0 && e.sourceIds.every((id) => generatedIds.has(id))).length,
    summaries,
    meters,
    columns,
    daily,
    totals,
    inflow: volume("inletTotaliser", "inletFlow"),
    outflow: volume("outletTotaliser", "outletFlow"),
    energyUsed: meterOf("energyKwh")?.total ?? null,
    corrected,
    excluded: summaries.reduce((n, s) => n + s.excluded, 0) + meters.reduce((n, m) => n + m.excluded, 0),
    aboveCap: summaries.reduce((n, s) => n + s.aboveCap, 0),
    setAside: summaries.reduce((n, s) => n + s.setAside, 0),
    folded: rows.reduce((n, e) => n + e.sourceIds.length - 1, 0),
    conflicts: rows.reduce((n, e) => n + e.conflicts, 0),
    remarks: rows
      .filter((e) => str(e.remarks).trim() !== "")
      .map((e) => ({ id: str(e.id), date: e.date, shift: e.shift ?? null, text: str(e.remarks).trim() })),
  };
}

const METER_FIGURE: Partial<Record<ParamKey, string>> = {
  inletTotaliser: "Inlet volume",
  outletTotaliser: "Outlet volume",
  energyKwh: "Energy used",
};

function times(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

// Plain sentences saying how the report's figures were arrived at, and what
// was left out of them. Printed under the report so a reader can check.
export function reportNotes(r: MonthReport): string[] {
  const notes: string[] = [];
  for (const m of r.meters) {
    const what = METER_FIGURE[m.key] ?? PARAMS[m.key].label;
    // "Inlet flow meter reading" -> "inlet flow meter", so the sentence can say "readings".
    const meter = PARAMS[m.key].label.toLowerCase().replace(/ reading$/, "");
    if (m.total === null) {
      notes.push(
        `${what} could not be worked out: it needs two ${meter} readings in sequence, and the month has ${m.readings === 1 ? "only one" : m.readings === 0 ? "none that can be used" : "none that rise from one to the next"}.`,
      );
    } else {
      let s = `${what} is the sum of the increases between consecutive ${meter} readings, from the reading of ${shortDate(m.from ?? "")} to the reading of ${shortDate(m.to ?? "")}.`;
      if (!m.carriedIn) s += ` No usable reading was taken in the ${MAX_CARRY_DAYS} days before the month, so what passed before the reading of ${shortDate(m.from ?? "")} is not included.`;
      if (m.spans > 0) s += ` ${m.spans} of the increases cover${m.spans === 1 ? "s" : ""} more than one day, because readings in between are missing or were left out; each is shown against the later date.`;
      notes.push(s);
    }
    if (m.falls > 0) {
      notes.push(
        `The ${meter} reading went down ${times(m.falls)} (meter replaced or reset, or a misread figure). Nothing is counted for ${m.falls === 1 ? "that step" : "those steps"}, so the total may be low.`,
      );
    }
    if (m.jumps > 0) {
      notes.push(
        `The ${meter} rose by far more than it usually does ${times(m.jumps)} (listed under the record-keeping observations): a slipped digit, or a meter swapped for one with a higher reading. Nothing is counted for ${m.jumps === 1 ? "that step" : "those steps"}, so the total may be low. Correct the reading in the Log if it was misread.`,
      );
    }
    if (m.outOfSequence > 0) {
      notes.push(
        `${m.outOfSequence} ${meter} reading${m.outOfSequence === 1 ? "" : "s"} did not fit between the readings before and after ${m.outOfSequence === 1 ? "it" : "them"} and ${m.outOfSequence === 1 ? "was" : "were"} left out; the increase is counted across ${m.outOfSequence === 1 ? "it" : "them"}.`,
      );
    }
    if (m.unplaced) {
      notes.push(
        `The ${meter} rose by ${fmtNum(m.unplaced.amount, PARAMS[m.key].decimals)} ${PARAMS[m.key].unit} between the reading of ${shortDate(m.unplaced.from)} and the next one, on ${shortDate(m.unplaced.to)}. Nothing is counted after the reading of ${shortDate(m.unplaced.from)}: that increase runs across the month end with no reading within ${MAX_CARRY_DAYS} days of it, so it is in neither month's total.`,
      );
    }
  }
  // Volumes summed from per-entry figures are only as complete as the entries.
  const summed = [r.inflow, r.outflow].filter((v) => v?.source === "entries").length;
  const missing = r.expected - r.recorded;
  if (summed > 0 && missing > 0) {
    const unit = r.perDay === 1 ? "daily" : "shift";
    notes.push(
      `The inlet and outlet volumes are the sum of the ${r.recorded} ${unit} ${r.recorded === 1 ? "entry" : "entries"} on record. ${missing} expected ${missing === 1 ? "entry is" : "entries are"} missing, so the totals leave out whatever passed ${r.perDay === 1 ? "on those days" : "in those shifts"}.`,
    );
  }
  const impossible = r.excluded - r.aboveCap;
  if (impossible > 0) {
    notes.push(
      `${impossible} value${impossible === 1 ? "" : "s"} outside the physically possible range ${impossible === 1 ? "is" : "are"} left out of the statistics and totals.`,
    );
  }
  if (r.setAside > 0) {
    const which = r.summaries.filter((s) => s.setAside > 0).map((s) => PARAMS[s.key].label.toLowerCase()).join(", ");
    notes.push(
      `${r.setAside} value${r.setAside === 1 ? "" : "s"} (${which}) ${r.setAside === 1 ? "is" : "are"} far out of scale for this plant or for the column's usual figure, most often a slipped digit or a wrong unit (listed under the record-keeping observations). ${r.setAside === 1 ? "It is" : "They are"} shown in the daily record as written, marked *, and left out of the minimum, average, maximum and totals until the entry is corrected in the Log or the plant's capacity setting is changed.`,
    );
  }
  if (r.aboveCap > 0) {
    const which = r.summaries.filter((s) => s.aboveCap > 0).map((s) => PARAMS[s.key].short).join(", ");
    notes.push(
      `${r.aboveCap} outlet reading${r.aboveCap === 1 ? "" : "s"} (${which}) ${r.aboveCap === 1 ? "is" : "are"} higher than a plant of this kind would normally show: a slip of the pen or a very large exceedance. ${r.aboveCap === 1 ? "It is" : "They are"} left out of the minimum, average and maximum, but ${r.aboveCap === 1 ? "it is" : "they are"} still compared with the consent limit and shown in the daily record.`,
    );
  }
  if (r.folded > 0) {
    const where = r.perDay === 1 ? "date" : "date and shift";
    let s = `${r.folded} saved ${r.folded === 1 ? "entry was" : "entries were"} for a ${where} that already had one; they are combined into one row each so nothing is counted twice.`;
    if (r.conflicts > 0) {
      s += ` ${r.conflicts} value${r.conflicts === 1 ? "" : "s"} differed between them; the most recently saved one is used. Check ${r.conflicts === 1 ? "it" : "them"} in the Log.`;
    }
    notes.push(s);
  }
  return notes;
}

// ------------------------------------------------- which month, which flags

export interface MonthStat {
  month: string; // "YYYY-MM"
  entries: number; // register rows dated in the month
  days: number; // dates in the month that have an entry
}

// Every month that has an entry, newest first, with how much is in it.
export function monthStats(entries: readonly LogEntry[] | null | undefined, perDay: 1 | 2 | 3): MonthStat[] {
  const byMonth = new Map<string, { entries: number; dates: Set<string> }>();
  for (const e of mergeSlots(entries, perDay).rows) {
    if (!isValidDate(e.date)) continue;
    const m = e.date.slice(0, 7);
    const g = byMonth.get(m) ?? { entries: 0, dates: new Set<string>() };
    g.entries++;
    g.dates.add(e.date);
    byMonth.set(m, g);
  }
  return [...byMonth.entries()]
    .map(([month, g]) => ({ month, entries: g.entries, days: g.dates.size }))
    .sort((a, b) => cmp(b.month, a.month));
}

// A month with entries on fewer days than this is "only just begun".
export const PARTIAL_MONTH_DAYS = 7;

// The month the report opens on: the latest one with a week of entries. The
// latest month of all is often two or three days old, and a report on it says
// almost nothing. When no month has a week of entries, the latest is used.
export function defaultMonth(stats: readonly MonthStat[] | null | undefined): string | null {
  const list = Array.isArray(stats) ? stats : [];
  return (list.find((s) => s.days >= PARTIAL_MONTH_DAYS) ?? list[0])?.month ?? null;
}

// The flags of the whole log that belong in one month's report: those dated
// in the month, and those that point at an entry dated in the month. The
// checks are run once on the whole log, not month by month, because a rule
// that looks across entries (a meter that fell between the 31st and the 1st,
// a run of copied rows, days missing at the month end) sees nothing when it is
// given one month alone.
export function flagsForMonth(
  flags: readonly Flag[] | null | undefined,
  entries: readonly LogEntry[] | null | undefined,
  month: string,
): Flag[] {
  if (!Array.isArray(flags) || !/^\d{4}-\d{2}$/.test(month ?? "")) return [];
  const inMonth = new Set<string>();
  for (const e of sortLog(entries)) if (isValidDate(e.date) && e.date.slice(0, 7) === month && typeof e.id === "string") inMonth.add(e.id);
  return flags.filter(
    (f) =>
      !!f && typeof f === "object" &&
      ((isValidDate(f.date) && f.date.slice(0, 7) === month) || (Array.isArray(f.entryIds) && f.entryIds.some((id: string) => inMonth.has(id)))),
  );
}

// ------------------------------------------------------------- trend series

export interface TrendPoint {
  i: number; // position of the entry in the sorted list (the x axis)
  entry: LogEntry;
  // The value plotted. In increase mode this is the increase per usual
  // interval: the whole increase for a normal point, an average for a span.
  v: number;
  days: number | null; // increase mode: days since the reading it is counted from
  total: number | null; // increase mode: the whole increase since that reading
  since: LogEntry | null; // increase mode: the entry that reading is in
  // Increase mode: how many usual intervals the increase covers. 1 for an
  // increase between two consecutive readings; more when the readings in
  // between are missing or were set aside. Always 1 in reading mode.
  span: number;
}

export interface TrendSeries {
  // "increase": a cumulative meter, plotted as what it gained per entry. The
  // raw readings only ever rise, which shows nothing.
  mode: "reading" | "increase";
  points: TrendPoint[];
  skipped: number; // entered but NaN or impossible: not plotted, not judged
  // Outlet strengths above what this kind of plant would show. Not plotted
  // (one would flatten the whole trend), but the limit rule judges them, so
  // the chart counts them among the readings outside the limit.
  aboveCap: { entry: LogEntry; v: number }[];
  falls: number; // increase mode: steps where the meter went down
  outOfSequence: number; // increase mode: readings left out as misreads
  spans: number; // increase mode: points that are an average over more than one interval
  // Increase mode: what one interval is. "day" or "shift" when the meter is
  // read at every entry (or once a day at a shift plant); "reading" when it is
  // read at some other rhythm, and the increase is simply since the last one.
  per: "day" | "shift" | "reading";
}

export interface TrendOptions {
  kind?: PlantKind;
  perDay?: 1 | 2 | 3;
}

export function trendSeries(sorted: readonly LogEntry[] | null | undefined, k: ParamKey, opts: TrendOptions = {}): TrendSeries {
  const rows = Array.isArray(sorted) ? sorted.filter((e): e is LogEntry => !!e && typeof e === "object") : [];
  const perDay = opts.perDay === 1 || opts.perDay === 2 || opts.perDay === 3 ? opts.perDay : 1;
  let skipped = 0;
  const aboveCap: { entry: LogEntry; v: number }[] = [];
  for (const e of rows) {
    const v = raw(e, k);
    if (!written(v) || isReal(k, v, opts.kind)) continue;
    if (isJudged(k, v, opts.kind)) aboveCap.push({ entry: e, v });
    else skipped++;
  }
  if (PARAMS[k].kind === "cumulative") {
    const steps = meterSteps(rows, k);
    const pos = slotPositions(rows, perDay);
    const counted = steps.filter((s) => s.increase !== null);
    // Entry slots each increase covers. An increase that spans a missing
    // entry, or a reading that was set aside, is not one shift's (or one
    // day's) worth: plotted as it stands it shows up as a spike, becomes the
    // chart's "highest" value and sets its scale.
    const width = counted.map((s) => {
      const a = s.base === null ? null : pos[s.base];
      const b = pos[s.index];
      return a === null || a === undefined || b === null ? null : Math.max(1, b - a);
    });
    // The meter's own rhythm: a meter read once a day in a three-shift
    // register has a usual width of three slots, and that is not a gap.
    const known = width.filter((w): w is number => w !== null).sort((a, b) => a - b);
    const usual = known.length ? known[(known.length - 1) >> 1] : 1;
    const points = counted.map((s, j) => {
      const span = width[j] === null ? 1 : Math.max(1, (width[j] as number) / usual);
      const total = s.increase as number;
      return {
        i: s.index, entry: s.entry, v: span > 1 ? total / span : total, days: s.days, total,
        since: s.base === null ? null : (rows[s.base] ?? null), span,
      };
    });
    return {
      mode: "increase",
      points,
      skipped,
      aboveCap,
      falls: steps.filter((s) => s.status === "fall").length,
      outOfSequence: steps.filter((s) => s.status === "outOfSequence").length,
      spans: points.filter((p) => p.span > 1).length,
      per: usual === perDay ? "day" : usual === 1 ? "shift" : "reading",
    };
  }
  const points: TrendPoint[] = [];
  rows.forEach((entry, i) => {
    const v = readingOf(entry, k, opts.kind);
    if (v !== null) points.push({ i, entry, v, days: null, total: null, since: null, span: 1 });
  });
  return { mode: "reading", points, skipped, aboveCap, falls: 0, outOfSequence: 0, spans: 0, per: perDay === 1 ? "day" : "shift" };
}

// --------------------------------------------------------------- chart maths

// Round axis values covering lo..hi. Always at least two ticks, always
// increasing, never NaN: a chart of one point, of identical values or of
// zeros still gets a usable axis. minStep keeps whole-number quantities from
// getting ticks at 0.2.
export function niceTicks(lo: number, hi: number, count = 4, minStep = 0): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi < lo) [lo, hi] = [hi, lo];
  const floor = Number.isFinite(minStep) && minStep > 0 ? minStep : 0;
  let span = hi - lo;
  if (span <= 0) {
    span = Math.max(Math.abs(lo) * 0.1, floor, 1e-6);
    hi = lo + span;
  }
  const rawStep = span / Math.max(1, Math.floor(count) || 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) ?? rawStep;
  if (step < floor) step = floor;
  // At very large values a small step vanishes in floating point (1e15 + 1e-7
  // is 1e15), and the loop below would never advance.
  const plain = [lo, hi > lo ? hi : lo + Math.max(1, Math.abs(lo) * 1e-9)];
  if (!(step > 0) || lo + step === lo) return plain;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let n = 0; n <= 12; n++) {
    // toPrecision trims float noise (0.30000000000000004); when it also
    // erases the step itself, round ticks are not possible for this range.
    const v = Number((start + n * step).toPrecision(12));
    if (out.length && v <= out[out.length - 1]) return plain;
    out.push(v);
    if (v >= hi) break;
  }
  return out.length < 2 ? plain : out;
}

// Which points to draw when there are far more points than pixels. For each
// pixel column it keeps the first, lowest, highest and last point, so every
// spike survives and the line looks the same. xs must be in drawing order.
// Returns indices into the input, ascending. Hover does not use this: it
// reads the full series.
export function thinForDrawing(xs: readonly number[], ys: readonly number[]): number[] {
  const n = Math.min(xs.length, ys.length);
  const keep: number[] = [];
  let i = 0;
  while (i < n) {
    const col = Math.floor(xs[i]);
    let j = i;
    let lo = i;
    let hi = i;
    while (j + 1 < n && Math.floor(xs[j + 1]) === col) {
      j++;
      if (ys[j] < ys[lo]) lo = j;
      if (ys[j] > ys[hi]) hi = j;
    }
    for (const idx of [...new Set([i, lo, hi, j])].sort((a, b) => a - b)) keep.push(idx);
    i = j + 1;
  }
  return keep;
}

// Index of the value in an ascending list that is closest to x. -1 when the
// list is empty.
export function nearestIndex(sortedXs: readonly number[], x: number): number {
  const n = sortedXs.length;
  if (!n) return -1;
  if (!Number.isFinite(x)) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedXs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(sortedXs[lo - 1] - x) <= Math.abs(sortedXs[lo] - x) ? lo - 1 : lo;
}
