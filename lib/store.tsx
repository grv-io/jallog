"use client";

// All plant data lives in the browser (IndexedDB). Nothing is stored on a
// server; a photo is sent out only to be read (see /api/extract).
//
// The file has three layers, top to bottom:
//   1. pure helpers (dates, slot keys, merge-on-save, validation of stored data)
//   2. a small storage "vault" that owns persistence and talks to other tabs
//   3. the React provider and hook
// Layers 1 and 2 use no browser API directly, so lib/__tests__/store.test.ts
// runs them in Node with an in-memory key-value store.

import { createContext, createElement, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { delMany, get, keys, set, update } from "idb-keyval";
import { runChecks } from "./checks";
import { buildDailySeed, buildSeed } from "./seed";
import { PARAM_KEYS } from "./types";
import type { CellMeta, ChecksResult, Limits, LogEntry, LogPage, ParamKey, Plant, ShiftCode } from "./types";

// The one privacy statement, used word for word wherever the app explains
// where data goes. The photo carries every reading, name and signature on the
// page, so the sentence says that the page itself leaves the device, and what
// Google's terms for unpaid Gemini API use allow
// (https://ai.google.dev/gemini-api/terms, "Unpaid Services").
export const PRIVACY_COPY =
  "The saved record stays in this browser. The photo of the page, with everything written on it, goes through JalLog's server to Google's Gemini service to be read; JalLog's server does not keep it. On a free Gemini key, Google may keep the photo, use it to improve its products and have people review it, so pages with names or signatures on them need a paid key.";

// ------------------------------------------------------------------ dates

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// True only for a real calendar date written as YYYY-MM-DD. Takes anything,
// because the values it is asked about come from storage and from a model.
export function isIsoDate(s: unknown): boolean {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Today in the device's own time zone (toISOString would give the UTC date,
// which is yesterday for the first 5.5 hours of an Indian morning).
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Whole days from a to b. NaN when either is not a valid date, so a caller
// comparing the result (age > 400) never acts on a bad date by accident.
export function daysBetween(a: string, b: string): number {
  if (!isIsoDate(a) || !isIsoDate(b)) return NaN;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// Returns the input unchanged when it is not a date or the result would leave
// the four-digit-year range.
export function addDays(iso: string, n: number): string {
  if (!isIsoDate(iso) || !Number.isFinite(n)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d + Math.trunc(n));
  if (Number.isNaN(t)) return iso;
  const out = new Date(t).toISOString().slice(0, 10);
  return isIsoDate(out) ? out : iso;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "5 Sep", "5 Sep 2026", "September 2026": day, month, year in that order,
// whichever of them `opts` asks for. Written out rather than left to the
// browser's locale data, which spells the short month "Sep" in one browser
// and "Sept" in the next; the flag texts (lib/checks.ts) always say "Sep".
export function formatDate(iso: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }): string {
  if (!isIsoDate(iso)) return (typeof iso === "string" && iso.trim()) || "no date";
  const [y, m, d] = iso.split("-").map(Number);
  const parts: string[] = [];
  if (opts.day) parts.push(String(d));
  if (opts.month) parts.push(opts.month === "long" ? MONTHS[m - 1] : MONTHS[m - 1].slice(0, 3));
  if (opts.year) parts.push(opts.year === "2-digit" ? String(y).slice(-2) : String(y));
  return parts.join(" ") || iso;
}

// A moment in the device's own time zone, as "5 Sep 2026, 18:05". "" when the
// value is not a time at all.
export function formatDateTime(iso: unknown): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return `${formatDate(day, { day: "numeric", month: "short", year: "numeric" })}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

const SHIFT_ORDER: Record<ShiftCode, number> = { A: 0, B: 1, C: 2 };
const shiftRank = (s: unknown): number => (s === "A" || s === "B" || s === "C" ? SHIFT_ORDER[s] : 3);

export function sortEntries(entries: LogEntry[]): LogEntry[] {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return [...(entries ?? [])].sort(
    (a, b) =>
      str(a.date).localeCompare(str(b.date)) ||
      shiftRank(a.shift) - shiftRank(b.shift) ||
      str(a.time).localeCompare(str(b.time)) ||
      str(a.id).localeCompare(str(b.id)),
  );
}

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ------------------------------------------------- register kinds and slots

export type ShiftsPerDay = Plant["shiftsPerDay"];

// "daily" = one row a day with meter readings and dosing; "shift" = a row per
// shift (or per clock time) with lab-style readings.
export type RegisterKind = "shift" | "daily";

export function registerKind(plant: Pick<Plant, "shiftsPerDay"> | null | undefined): RegisterKind {
  return plant?.shiftsPerDay === 1 ? "daily" : "shift";
}

// Identifies the slot of the register an entry fills, so that reading the same
// page twice replaces rows instead of doubling them.
//   - one row a day (shiftsPerDay 1): the date alone
//   - otherwise: date + shift letter, or date + clock time
//   - null when the row cannot be placed (no valid date, or neither a shift nor
//     a time). Such rows can never be matched up, so they are always added.
export function slotKey(
  e: Pick<LogEntry, "date" | "shift" | "time">,
  shiftsPerDay: ShiftsPerDay | null | undefined,
): string | null {
  if (!e || !isIsoDate(e.date)) return null;
  if (shiftsPerDay === 1) return e.date;
  const slot = e.shift || e.time;
  return slot ? `${e.date}|${slot}` : null;
}

// A daily register is often spread over two facing pages: meter readings on
// one, dosing and sludge on the other, both for the same dates. When the
// second page is saved, the columns it does not have must survive. A column
// counts as "on the page" when the incoming row carries its key at all, even
// as null (a blank cell): a cell the reviewer left blank replaces the old
// value, a column the page never had does not.
//
// Operator and remarks follow the same rule, with "" standing in for the key:
// null means "this page has no such column" (the old text is kept), "" means
// "the page has the column and the reviewer left this cell empty" (the old
// text goes). mergeEntries turns "" back into null before anything is stored.
function carryOver(incoming: LogEntry, old: LogEntry): LogEntry {
  const values: LogEntry["values"] = { ...incoming.values };
  const cellMeta: NonNullable<LogEntry["cellMeta"]> = { ...(incoming.cellMeta ?? {}) };
  const edited = new Set<ParamKey>(incoming.edited ?? []);
  let carried = false;
  for (const k of PARAM_KEYS) {
    const was = old.values?.[k];
    if (incoming.values?.[k] !== undefined || typeof was !== "number" || !Number.isFinite(was)) continue;
    values[k] = was;
    const meta = old.cellMeta?.[k];
    if (meta) cellMeta[k] = meta;
    if (old.edited?.includes(k)) edited.add(k);
    carried = true;
  }
  const operator = incoming.operator == null ? old.operator ?? null : incoming.operator;
  const remarks = incoming.remarks == null ? old.remarks ?? null : incoming.remarks;
  if (!carried && operator === incoming.operator && remarks === incoming.remarks) return incoming;
  return {
    ...incoming, values, operator, remarks,
    ...(incoming.cellMeta || Object.keys(cellMeta).length > 0 ? { cellMeta } : {}),
    ...(incoming.edited || edited.size > 0 ? { edited: PARAM_KEYS.filter((k) => edited.has(k)) } : {}),
  };
}

// Merge-on-save. An incoming entry replaces an existing one only when both
// fill the same slot (or carry the same id). Everything else is kept: two
// incoming rows for one slot are both stored, because dropping one would lose
// something the user confirmed on the review screen.
//
// In a one-row-a-day register the replacement keeps the values of columns the
// incoming row does not have (see carryOver), so the second of two facing
// pages adds to the day's row instead of wiping the first page's readings.
export function mergeEntries(
  existing: LogEntry[],
  incoming: LogEntry[],
  shiftsPerDay: ShiftsPerDay | null | undefined,
): { entries: LogEntry[]; replaced: LogEntry[] } {
  const ids = new Set(incoming.map((e) => e.id));
  const slots = new Set<string>();
  for (const e of incoming) {
    const k = slotKey(e, shiftsPerDay);
    if (k !== null) slots.add(k);
  }
  const kept: LogEntry[] = [];
  const replaced: LogEntry[] = [];
  // Daily register only: what each date held before, oldest first. An entry
  // replaced because its own id came in again is an edit, not a second page.
  const before = new Map<string, LogEntry[]>();
  for (const e of existing) {
    const k = slotKey(e, shiftsPerDay);
    if (ids.has(e.id) || (k !== null && slots.has(k))) {
      replaced.push(e);
      if (shiftsPerDay === 1 && k !== null && !ids.has(e.id)) before.set(k, [...(before.get(k) ?? []), e]);
    } else kept.push(e);
  }
  if (before.size === 0) return { entries: [...kept, ...incoming.map(tidyText)], replaced };
  const merged = incoming.map((e) => {
    const k = slotKey(e, shiftsPerDay);
    const olds = k === null ? undefined : before.get(k);
    if (!k || !olds) return e;
    // Only the first incoming row for a date takes the earlier values.
    before.delete(k);
    return olds.reduce((row, old) => carryOver(row, old), e);
  });
  return { entries: [...kept, ...merged.map(tidyText)], replaced };
}

// "" for operator or remarks only ever means "cleared on purpose" on the way
// into a merge (see carryOver). What is stored says null.
function tidyText(e: LogEntry): LogEntry {
  return e.operator === "" || e.remarks === "" ? { ...e, operator: e.operator || null, remarks: e.remarks || null } : e;
}

// What saving a reviewed page would do to the entries already in the log,
// worked out before the save so the review screen can say it in advance.
export interface SaveImpact {
  // Rows of the page that land on a slot the log already has an entry for.
  replaces: number;
  // Saved entries that would leave the log. More than `replaces` when one date
  // of a daily register holds several entries (a plant switched from shifts).
  removed: number;
  // Daily register only: dates on the page that hold more than one saved entry.
  crowded: { date: string; count: number; shifts: string[] }[];
  // Saved values a person changed by hand that this page would overwrite with
  // something different. `row` is the index into `incoming`.
  corrections: { row: number; param: ParamKey; saved: number | null; incoming: number | null }[];
}

export function saveImpact(
  existing: LogEntry[],
  incoming: Pick<LogEntry, "date" | "shift" | "time" | "values">[],
  shiftsPerDay: ShiftsPerDay | null | undefined,
): SaveImpact {
  const out: SaveImpact = { replaces: 0, removed: 0, crowded: [], corrections: [] };
  const bySlot = new Map<string, LogEntry[]>();
  for (const e of existing ?? []) {
    const k = slotKey(e, shiftsPerDay);
    if (k !== null) bySlot.set(k, [...(bySlot.get(k) ?? []), e]);
  }
  const seen = new Set<string>();
  (incoming ?? []).forEach((row, i) => {
    const k = slotKey(row, shiftsPerDay);
    // Only the first row of the page for a slot counts: a second one is a
    // duplicate, which the review screen refuses to save.
    if (k === null || seen.has(k)) return;
    seen.add(k);
    const olds = bySlot.get(k);
    if (!olds) return;
    out.replaces++;
    out.removed += olds.length;
    if (shiftsPerDay === 1 && olds.length > 1) {
      out.crowded.push({ date: row.date, count: olds.length, shifts: olds.map((e) => e.shift || e.time || "").filter(Boolean) });
    }
    for (const old of olds) {
      for (const param of PARAM_KEYS) {
        if (!Array.isArray(old.edited) || !old.edited.includes(param)) continue;
        const next = row.values?.[param];
        if (next === undefined) continue; // not a column of this page: the saved value stays
        const was = old.values?.[param];
        const saved = typeof was === "number" && Number.isFinite(was) ? was : null;
        if (saved !== next) out.corrections.push({ row: i, param, saved, incoming: next });
      }
    }
  });
  return out;
}

// Fills the dates a reader could not make out, working down the page the way
// a register is written: a daily register moves on one day per row; a shift
// register moves on a day when the shift letter (or the clock time) starts
// again. Rows that already have a valid date are left alone and re-anchor the
// count. `start` is used only for undated rows above the first dated one.
export function fillBlankDates<T extends { date: string; shift?: ShiftCode | "" | null; time?: string | null }>(
  rows: T[],
  start: string,
  shiftsPerDay: ShiftsPerDay | null | undefined,
): T[] {
  let cur: string | null = null;
  let prev: T | null = null;
  return rows.map((row) => {
    let out = row;
    if (isIsoDate(row.date)) {
      cur = row.date;
    } else {
      if (cur === null) cur = isIsoDate(start) ? start : null;
      else if (prev && startsNewDay(prev, row, shiftsPerDay)) cur = addDays(cur, 1);
      if (cur !== null) out = { ...row, date: cur };
    }
    prev = row;
    return out;
  });
}

function startsNewDay(
  prev: { shift?: ShiftCode | "" | null; time?: string | null },
  row: { shift?: ShiftCode | "" | null; time?: string | null },
  shiftsPerDay: ShiftsPerDay | null | undefined,
): boolean {
  if (shiftsPerDay === 1) return true;
  if (prev.shift && row.shift) return shiftRank(row.shift) <= shiftRank(prev.shift);
  if (prev.time && row.time) return row.time <= prev.time;
  return false;
}

// ------------------------------------------------------------------ state

export interface State {
  plant: Plant | null;
  entries: LogEntry[];
  // Page photos are kept under their own keys (IMG_PREFIX + id) so that saving
  // an edit does not rewrite every photo; imageDataUrl is "" in this list.
  pages: LogPage[];
}

export const EMPTY: State = { plant: null, entries: [], pages: [] };

type Op = (s: State) => State;

// A page record is only reachable through the entries that came from it. Once
// the last of those is deleted or replaced, the record (and its photo) is
// dead weight in a browser with limited storage.
function prunePages(s: State): State {
  if (s.pages.length === 0) return s;
  const used = new Set(s.entries.map((e) => e.pageId));
  const pages = s.pages.filter((p) => used.has(p.id));
  return pages.length === s.pages.length ? s : { ...s, pages };
}

// Every change to the record is one of these. They are pure, because the
// vault runs each one twice: once on the copy on screen, and once on the copy
// in storage (which another tab may have changed in between).
export const ops = {
  savePlant: (plant: Plant): Op => (s) => ({ ...s, plant }),
  addEntries: (page: LogPage | null, entries: LogEntry[]): Op => (s) => {
    const pages = page
      ? [...s.pages.filter((p) => p.id !== page.id), { ...page, imageDataUrl: "" }]
      : s.pages;
    return prunePages({ ...s, pages, entries: mergeEntries(s.entries, entries, s.plant?.shiftsPerDay).entries });
  },
  updateEntry: (entry: LogEntry): Op => (s) => ({ ...s, entries: s.entries.map((e) => (e.id === entry.id ? entry : e)) }),
  deleteEntry: (id: string): Op => (s) => prunePages({ ...s, entries: s.entries.filter((e) => e.id !== id) }),
  replaceAll: (next: State): Op => () => next,
};

// --------------------------------------------- validation of stored data
//
// What comes back from IndexedDB was written by some earlier build of this
// app, or by nobody we know. It is checked field by field: anything usable is
// kept, anything else is counted and left out, and nothing here throws.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function finite(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function cleanTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function cleanValues(raw: unknown): LogEntry["values"] {
  const out: LogEntry["values"] = {};
  if (!isObj(raw)) return out;
  for (const k of PARAM_KEYS) {
    if (raw[k] === null) out[k] = null;
    else {
      const n = finite(raw[k]);
      if (n !== undefined) out[k] = n;
    }
  }
  return out;
}

function cleanCellMeta(raw: Record<string, unknown>): Partial<Record<ParamKey, CellMeta>> {
  const out: Partial<Record<ParamKey, CellMeta>> = {};
  for (const k of PARAM_KEYS) {
    const m = raw[k];
    // An unknown confidence is treated as "low": it needs a human look.
    if (isObj(m) && typeof m.raw === "string") out[k] = { raw: m.raw, confidence: m.confidence === "high" ? "high" : "low" };
  }
  return out;
}

function cleanEntry(raw: unknown, index: number, plantId: string): LogEntry | null {
  if (!isObj(raw)) return null;
  const values = cleanValues(raw.values);
  const date = asString(raw.date).trim();
  const remarks = textOrNull(raw.remarks);
  // A row with no date, no number and no remark records nothing.
  if (!date && !remarks && !Object.values(values).some((v) => typeof v === "number")) return null;
  const entry: LogEntry = {
    id: asString(raw.id) || `recovered-${index}`,
    plantId: asString(raw.plantId) || plantId,
    date,
    shift: raw.shift === "A" || raw.shift === "B" || raw.shift === "C" ? raw.shift : null,
    time: cleanTime(raw.time),
    operator: textOrNull(raw.operator),
    values,
    remarks,
    pageId: asString(raw.pageId) || null,
    capturedAt: asString(raw.capturedAt),
  };
  if (isObj(raw.cellMeta)) entry.cellMeta = cleanCellMeta(raw.cellMeta);
  if (Array.isArray(raw.edited)) {
    const edited: unknown[] = raw.edited;
    entry.edited = PARAM_KEYS.filter((k) => edited.includes(k));
  }
  return entry;
}

function cleanLimits(raw: unknown): Limits {
  const out: Limits = {};
  if (!isObj(raw)) return out;
  for (const k of PARAM_KEYS) {
    const l = raw[k];
    if (!isObj(l)) continue;
    const min = finite(l.min);
    const max = finite(l.max);
    if (min === undefined && max === undefined) continue;
    out[k] = { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
  }
  return out;
}

function cleanPlant(raw: unknown): Plant | null {
  if (!isObj(raw)) return null;
  const capacity = finite(raw.capacityKld);
  return {
    id: asString(raw.id) || "plant-recovered",
    name: textOrNull(raw.name) ?? "My plant",
    kind: raw.kind === "ETP" ? "ETP" : "STP",
    location: asString(raw.location),
    // 0 = not known. The Plant screen asks for it before the next save.
    capacityKld: capacity !== undefined && capacity > 0 ? capacity : 0,
    technology: asString(raw.technology),
    operatorCompany: asString(raw.operatorCompany),
    consentNo: asString(raw.consentNo),
    shiftsPerDay: raw.shiftsPerDay === 1 || raw.shiftsPerDay === 2 || raw.shiftsPerDay === 3 ? raw.shiftsPerDay : 3,
    limits: cleanLimits(raw.limits),
  };
}

function cleanPage(raw: unknown): { page: LogPage; photo: string | null } | null {
  if (!isObj(raw) || !asString(raw.id)) return null;
  const photo = asString(raw.imageDataUrl);
  return {
    page: {
      id: asString(raw.id),
      plantId: asString(raw.plantId),
      uploadedAt: asString(raw.uploadedAt),
      fileName: asString(raw.fileName),
      imageDataUrl: "",
      model: asString(raw.model),
      notes: Array.isArray(raw.notes) ? raw.notes.filter((n): n is string => typeof n === "string") : [],
      reviewedAt: textOrNull(raw.reviewedAt),
    },
    photo: photo.startsWith("data:image/") ? photo : null,
  };
}

export interface Loaded {
  state: State;
  rev: number;
  // "partial": something was unusable and left out. "unreadable": nothing
  // could be made of the stored value at all.
  problem: "none" | "partial" | "unreadable";
  dropped: number; // entries and page records left out
  // Photos found inside the record itself (an earlier storage layout).
  inlinePhotos: { id: string; dataUrl: string }[];
}

export function sanitizeState(raw: unknown): Loaded {
  const empty: Loaded = { state: EMPTY, rev: 0, problem: "none", dropped: 0, inlinePhotos: [] };
  if (raw === undefined || raw === null) return empty;
  if (!isObj(raw)) return { ...empty, problem: "unreadable" };
  try {
    const plant = cleanPlant(raw.plant);
    let damaged = (raw.plant != null && !plant)
      || (raw.entries != null && !Array.isArray(raw.entries))
      || (raw.pages != null && !Array.isArray(raw.pages));
    let dropped = 0;

    const entries: LogEntry[] = [];
    const seen = new Set<string>();
    (Array.isArray(raw.entries) ? raw.entries : []).forEach((r: unknown, i: number) => {
      const e = cleanEntry(r, i, plant?.id ?? "");
      if (!e) {
        dropped++;
        return;
      }
      // Two entries with one id would make every list on screen misbehave.
      // Keep both readings and rename the later one.
      if (seen.has(e.id)) {
        let n = 2;
        while (seen.has(`${e.id}~${n}`)) n++;
        e.id = `${e.id}~${n}`;
        damaged = true;
      }
      seen.add(e.id);
      entries.push(e);
    });

    const pages: LogPage[] = [];
    const inlinePhotos: Loaded["inlinePhotos"] = [];
    const pageIds = new Set<string>();
    for (const r of Array.isArray(raw.pages) ? raw.pages : []) {
      const p = cleanPage(r);
      if (!p || pageIds.has(p.page.id)) {
        dropped++;
        continue;
      }
      pageIds.add(p.page.id);
      pages.push(p.page);
      if (p.photo) inlinePhotos.push({ id: p.page.id, dataUrl: p.photo });
    }

    // Entries with no plant to belong to. The app never writes that, and every
    // screen would then show "choose a plant", one click from replacing them.
    if (!plant && entries.length > 0) damaged = true;

    const rev = finite(raw.rev);
    return {
      state: { plant, entries, pages },
      rev: rev !== undefined && rev >= 0 ? Math.floor(rev) : 0,
      problem: damaged || dropped > 0 ? "partial" : "none",
      dropped,
      inlinePhotos,
    };
  } catch {
    return { ...empty, problem: "unreadable" };
  }
}

// ------------------------------------------------------------ demo plants

export type DemoKind = "shift" | "daily";

// The sample logbook pages pick up on the day after each demo history ends.
export const DEMO_END: Record<DemoKind, string> = { shift: "2026-09-27", daily: "2026-09-20" };
export const DEMO_END_DATE = DEMO_END.shift;

const SEED_BUILDERS: Record<DemoKind, (endDate: string) => { plant: Plant; entries: LogEntry[] }> = {
  shift: buildSeed,
  daily: buildDailySeed,
};
const demoCache: Partial<Record<DemoKind, State | null>> = {};

// The generated record for a sample plant. It goes through the same checks as
// stored data, so a generator that misbehaves gives an unavailable sample
// (null) rather than a broken screen.
export function demoState(kind: DemoKind): State | null {
  if (kind in demoCache) return demoCache[kind] ?? null;
  let state: State | null = null;
  try {
    const made = SEED_BUILDERS[kind](DEMO_END[kind]);
    const clean = sanitizeState({ plant: made.plant, entries: made.entries, pages: [] }).state;
    if (clean.plant && clean.entries.length > 0) state = clean;
  } catch {
    state = null;
  }
  demoCache[kind] = state;
  return state;
}

// Which sample plant this is, or null for a plant the user set up. Decided by
// the plant's id alone: a sample plant whose "Shifts per day" was changed on
// the Plant screen still holds generated readings and must keep its label.
export function demoKindOf(plant: Pick<Plant, "id"> | null | undefined): DemoKind | null {
  if (!plant || typeof plant.id !== "string" || !plant.id) return null;
  for (const kind of ["shift", "daily"] as const) {
    if (demoState(kind)?.plant?.id === plant.id) return kind;
  }
  return null;
}

// ------------------------------------------------------------- full copies
//
// A CSV holds the readings only. A full copy also holds the plant, its limits,
// the page records and their photos, and can be loaded back in (another
// browser, or this one after its site data was cleared).

export interface Backup {
  app: "JalLog";
  format: 1;
  exportedAt: string; // ISO
  plant: Plant | null;
  entries: LogEntry[];
  pages: LogPage[];
  // Page photos by page id.
  photos: Record<string, string>;
}

export function makeBackup(state: State, photos: Record<string, string>, exportedAt = new Date().toISOString()): Backup {
  return { app: "JalLog", format: 1, exportedAt, plant: state.plant, entries: state.entries, pages: state.pages, photos };
}

export interface BackupRead {
  state: State;
  photos: Record<string, string>;
  // Entries and page records in the file that could not be used and are left out.
  dropped: number;
  // True when something in the file had to be repaired or left out.
  repaired: boolean;
  exportedAt: string; // "" when the file does not say
}

// Reads a file the user chose as a full copy. It goes through the same repair
// as stored data, so a hand-edited or damaged file gives what can be used, and
// null only when it holds no plant at all. The "stored copy" offered by the
// recovery banner has the same shape and is accepted too.
export function readBackup(raw: unknown): BackupRead | null {
  if (!isObj(raw)) return null;
  const res = sanitizeState(raw);
  if (res.problem === "unreadable" || !res.state.plant) return null;
  const state = prunePages(res.state);
  const live = new Set(state.pages.map((p) => p.id));
  const photos: Record<string, string> = {};
  for (const p of res.inlinePhotos) if (live.has(p.id)) photos[p.id] = p.dataUrl;
  if (isObj(raw.photos)) {
    for (const id of live) {
      const v = raw.photos[id];
      if (typeof v === "string" && v.startsWith("data:image/")) photos[id] = v;
    }
  }
  return {
    state,
    photos,
    dropped: res.dropped + (res.state.pages.length - state.pages.length),
    repaired: res.problem !== "none",
    exportedAt: asString(raw.exportedAt),
  };
}

// ------------------------------------------------------------------ vault

const KEY = "jallog:v1";
const IMG_PREFIX = "jallog:img:";
const DRAFT_KEY = "jallog:draft";
const DRAFT_IMG_KEY = "jallog:draft:img";

export const STORAGE_KEYS = { state: KEY, imagePrefix: IMG_PREFIX, draft: DRAFT_KEY, draftImage: DRAFT_IMG_KEY };

const STORAGE_MESSAGE =
  "This browser is not saving JalLog's data (private window, or storage is full). Changes made since this message appeared will be lost when the tab closes. Download the CSV from the Log screen to keep the readings.";
const PHOTO_MESSAGE =
  "The readings were saved, but the photo of the page could not be stored (storage is full). Until it is stored, the page shows without its photo.";
const CLEANUP_MESSAGE =
  "Some stored page photos could not be removed from this browser. Try the action again, or clear this site's data in the browser settings.";

// The storage calls the vault needs. idb-keyval in the app; a Map in tests.
export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  // Read-modify-write in one transaction, so two tabs cannot interleave.
  update(key: string, fn: (old: unknown) => unknown): Promise<void>;
  keys(): Promise<unknown[]>;
  delMany(keys: string[]): Promise<void>;
}

// A line to the other tabs of this browser (BroadcastChannel in the app).
export interface Wire {
  post(msg: unknown): void;
  listen(fn: (msg: unknown) => void): void;
  close(): void;
}

export interface Recovery {
  kind: "partial" | "unreadable";
  dropped: number;
  // The stored value exactly as found, so the user can download it before
  // anything overwrites it.
  raw: unknown;
}

export interface Snapshot {
  ready: boolean;
  state: State;
  storageError: string | null;
  // True when trying again could store something: a change the browser has
  // not accepted yet, or a page photo still held in memory.
  retryable: boolean;
  recovery: Recovery | null;
}

type Sweep = false | "photos" | "all";

// The page being checked on the Capture screen, as kept in storage. The rows
// and the photo live under two keys (the photo is large and written once), and
// both carry the review's id, so one review's rows can never come back beside
// another review's photo.
export interface StoredDraft {
  id: string; // "" for a copy written by a build that had no ids
  meta: unknown;
  // null when the stored photo is missing or belongs to a different review.
  image: string | null;
}

// Told to every tab when a tab removes the stored copy of a review.
export interface DraftCleared {
  id: string;
  reason: "saved" | "discarded";
}

// How many page photos that storage refused are kept in memory for a retry.
const MAX_UNSTORED_PHOTOS = 3;

const draftIdOf = (rec: unknown): string | null => (isObj(rec) && typeof rec.id === "string" && rec.id ? rec.id : null);

function sameData(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function createVault(kv: KV, openWire: () => Wire | null = () => null) {
  let snap: Snapshot = { ready: false, state: EMPTY, storageError: null, retryable: false, recovery: null };
  // The stored record as last read or written by this tab, and its revision.
  let base: State = EMPTY;
  let rev = -1;
  // Changes made in this tab that storage has not accepted yet. What is on
  // screen is always `base` with these applied, so a failed write keeps the
  // user's work in memory and the next write retries all of it. `after` runs
  // once the change is on disk (and never before).
  type Change = { op: Op; sweep: Sweep; after?: () => Promise<void> };
  let pending: Change[] = [];
  let stateError: string | null = null;
  let photoError: string | null = null;
  // Page photos storage refused, by page id, kept so a retry can store them
  // while the tab is open. Bounded: a photo is a few megabytes.
  const unstoredPhotos = new Map<string, string>();
  let photoGivenUp = false;
  // The review whose photo this tab knows to be in storage.
  let draftPhotoOwner: string | null = null;
  const draftListeners = new Set<(msg: DraftCleared) => void>();
  // One job at a time, in order: storage calls never overlap within a tab.
  let queue: Promise<void> = Promise.resolve();
  let wire: Wire | null = null;
  const listeners = new Set<() => void>();

  const emit = (patch: Partial<Snapshot>) => {
    const next = { ...snap, ...patch, retryable: stateError !== null || unstoredPhotos.size > 0 };
    if (
      next.ready === snap.ready && next.state === snap.state && next.storageError === snap.storageError &&
      next.recovery === snap.recovery && next.retryable === snap.retryable
    ) return;
    snap = next;
    listeners.forEach((l) => l());
  };
  const errors = () => stateError ?? photoError;
  // An op that throws must not take the record with it: the record is left as it was.
  const apply = (s: State, op: Op): State => {
    try {
      return op(s);
    } catch {
      return s;
    }
  };
  const view = () => pending.reduce((s, p) => apply(s, p.op), base);
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    queue = queue.then(job).catch(() => {});
    return queue;
  };

  // Reads the stored record. The first call fills the screen; later calls
  // pick up what another tab saved.
  function load(): Promise<void> {
    return enqueue(async () => {
      let raw: unknown;
      try {
        raw = await kv.get(KEY);
      } catch {
        stateError = STORAGE_MESSAGE;
        emit({ ready: true, storageError: errors() });
        return;
      }
      const res = sanitizeState(raw);
      const first = !snap.ready;
      if (!first && res.rev === rev) return;
      base = res.state;
      rev = res.rev;
      if (pending.length === 0) stateError = null;
      const next = view();
      emit({
        ready: true,
        state: sameData(next, snap.state) ? snap.state : next,
        storageError: errors(),
        ...(first && res.problem !== "none" ? { recovery: { kind: res.problem, dropped: res.dropped, raw } } : {}),
      });
      if (first && res.inlinePhotos.length > 0) {
        // Earlier layout: photos inside the record. Move each to its own key,
        // and only rewrite the record without them once every move succeeded.
        try {
          for (const p of res.inlinePhotos) await kv.set(IMG_PREFIX + p.id, p.dataUrl);
          pending.push({ op: (s) => s, sweep: false });
          void flush();
        } catch {
          photoError = PHOTO_MESSAGE;
          emit({ storageError: errors() });
        }
      }
      if (pending.length > 0) void flush();
    });
  }

  // Writes the pending changes. The stored record is read and rewritten in a
  // single transaction and the changes are applied to what is actually there,
  // so a save made in another tab a moment ago is built on, not overwritten.
  function flush(): Promise<void> {
    return enqueue(async () => {
      // A photo that was refused earlier goes first: "try again" means all of it.
      if (unstoredPhotos.size > 0) await storePhotos();
      if (pending.length === 0) return;
      const batch = pending.slice();
      const out: { written: (State & { rev: number }) | null } = { written: null };
      try {
        await kv.update(KEY, (raw) => {
          const cur = sanitizeState(raw);
          const next = batch.reduce((s, p) => apply(s, p.op), cur.state);
          out.written = { plant: next.plant, entries: next.entries, pages: next.pages, rev: cur.rev + 1 };
          return out.written;
        });
      } catch {
        out.written = null;
      }
      const written = out.written;
      if (!written) {
        stateError = STORAGE_MESSAGE;
        emit({ storageError: errors() });
        return;
      }
      const pagesBefore = base.pages;
      pending = pending.slice(batch.length);
      base = { plant: written.plant, entries: written.entries, pages: written.pages };
      rev = written.rev;
      stateError = null;
      const next = view();
      emit({ state: sameData(next, snap.state) ? snap.state : next, storageError: errors() });
      try {
        wire?.post({ type: "saved", rev });
      } catch {
        // A closed channel only means the other tabs find out when they next look.
      }
      for (const p of batch) {
        if (!p.after) continue;
        try {
          await p.after();
        } catch {
          // The change itself is stored; a follow-up that failed is not worth an error.
        }
      }

      // Photos whose page record is gone are removed, so "delete" really
      // frees the space. Pages still waiting in `pending` count as live.
      const sweep: Sweep = batch.some((p) => p.sweep === "all") ? "all" : batch.some((p) => p.sweep) ? "photos" : false;
      const lostPage = pagesBefore.some((p) => !written.pages.some((q) => q.id === p.id));
      if (!sweep && !lostPage) return;
      try {
        const live = new Set(snap.state.pages.map((p) => IMG_PREFIX + p.id));
        const doomed = (await kv.keys()).filter(
          (k): k is string =>
            typeof k === "string" &&
            ((k.startsWith(IMG_PREFIX) && !live.has(k)) || (sweep === "all" && (k === DRAFT_KEY || k === DRAFT_IMG_KEY))),
        );
        if (doomed.length > 0) await kv.delMany(doomed);
      } catch {
        photoError = CLEANUP_MESSAGE;
        emit({ storageError: errors() });
      }
    });
  }

  // Resolves true once the change is in storage, false when the write that
  // carried it was refused (it then stays on screen and in `pending`, and the
  // next write or "try again" takes it along).
  function mutate(op: Op, sweep: Sweep = false, after?: () => Promise<void>): Promise<boolean> {
    const change: Change = { op, sweep, after };
    pending.push(change);
    emit({ state: apply(snap.state, op) });
    return flush().then(() => !pending.includes(change));
  }

  // Runs inside a queue job. Tries every held photo again; drops the ones
  // whose page has left the record.
  async function storePhotos(): Promise<void> {
    let stored = 0;
    for (const [id, dataUrl] of [...unstoredPhotos]) {
      if (!snap.state.pages.some((p) => p.id === id)) {
        unstoredPhotos.delete(id);
        continue;
      }
      try {
        await kv.set(IMG_PREFIX + id, dataUrl);
        unstoredPhotos.delete(id);
        stored++;
      } catch {
        // still refused: keep it for the next try
      }
    }
    // The notice goes only when every photo it was about is now stored.
    if (stored > 0 && unstoredPhotos.size === 0 && !photoGivenUp && photoError === PHOTO_MESSAGE) photoError = null;
    emit({ storageError: errors() });
  }

  function putPhoto(pageId: string, dataUrl: string): void {
    void enqueue(async () => {
      try {
        await kv.set(IMG_PREFIX + pageId, dataUrl);
        unstoredPhotos.delete(pageId);
      } catch {
        unstoredPhotos.delete(pageId);
        unstoredPhotos.set(pageId, dataUrl);
        while (unstoredPhotos.size > MAX_UNSTORED_PHOTOS) {
          const oldest = unstoredPhotos.keys().next().value;
          if (oldest === undefined) break;
          unstoredPhotos.delete(oldest);
          photoGivenUp = true;
        }
        photoError = PHOTO_MESSAGE;
        emit({ storageError: errors() });
      }
    });
  }

  // `draftId`: the review this page was saved from. Its stored safety copy is
  // removed only after the entries are on disk, so until then a reload still
  // brings the reviewed page back.
  function addPage(page: LogPage | null, entries: LogEntry[], opts?: { draftId?: string }): Promise<boolean> {
    const photo = page?.imageDataUrl ?? "";
    if (page && photo) putPhoto(page.id, photo);
    const draftId = opts?.draftId;
    return mutate(ops.addEntries(page, entries), false, draftId ? () => removeDraft(draftId, "saved") : undefined);
  }

  // Everything in this browser replaced by a full copy (see readBackup).
  function restore(state: State, photos: Record<string, string>): Promise<boolean> {
    for (const p of state.pages) {
      const dataUrl = photos[p.id];
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) putPhoto(p.id, dataUrl);
    }
    return mutate(ops.replaceAll(state), "photos");
  }

  // The record on screen with its photos, for the user to keep as a file.
  function exportCopy(): Promise<Backup> {
    let out = makeBackup(snap.state, {});
    return enqueue(async () => {
      const state = snap.state;
      const photos: Record<string, string> = {};
      for (const p of state.pages) {
        try {
          const v = await kv.get(IMG_PREFIX + p.id);
          if (typeof v === "string" && v.startsWith("data:image/")) photos[p.id] = v;
        } catch {
          // a photo that cannot be read is left out; the readings still go in
        }
        const held = unstoredPhotos.get(p.id);
        if (!photos[p.id] && held) photos[p.id] = held;
      }
      out = makeBackup(state, photos);
    }).then(() => out);
  }

  // The read takes its turn in the same queue as the writes. A photo saved a
  // moment ago is therefore always there to be read, and a read asked for just
  // before a delete still gets the photo (the Log's Undo relies on that).
  function getPageImage(pageId: string): Promise<string | null> {
    let found: string | null = null;
    return enqueue(async () => {
      try {
        const v = await kv.get(IMG_PREFIX + pageId);
        found = typeof v === "string" && v.startsWith("data:image/") ? v : null;
      } catch {
        found = null;
      }
    }).then(() => found);
  }

  // The page being checked on the Capture screen, kept so that leaving the
  // screen (or a reload) does not throw away a reading the user was correcting.
  //
  // Runs inside a queue job. With an id, removes the stored copy only when it
  // is that review's: a tab closing its own review must not take away a copy
  // another tab has stored since.
  async function removeDraft(id: string | undefined, reason: DraftCleared["reason"]): Promise<void> {
    let stored: string | null = null;
    try {
      const rec = await kv.get(DRAFT_KEY);
      stored = draftIdOf(rec);
      if (id && stored !== null && stored !== id) return;
      await kv.delMany([DRAFT_KEY, DRAFT_IMG_KEY]);
      draftPhotoOwner = null;
      if (rec === undefined || rec === null) return;
    } catch {
      // Left behind at worst; "Delete all data" removes it.
      return;
    }
    try {
      wire?.post({ type: "draft-cleared", id: stored ?? "", reason });
    } catch {
      // A closed channel: the other tabs find out on their next edit.
    }
  }

  const draft = {
    // Takes its turn in the queue, so it never reads half of this tab's own write.
    load(): Promise<StoredDraft | null> {
      let found: StoredDraft | null = null;
      return enqueue(async () => {
        try {
          const rec = await kv.get(DRAFT_KEY);
          if (rec === undefined || rec === null) return;
          const img = await kv.get(DRAFT_IMG_KEY);
          const id = draftIdOf(rec);
          if (id !== null && isObj(rec)) {
            const image = isObj(img) && img.id === id && typeof img.dataUrl === "string" ? img.dataUrl : null;
            // Remember whose photo is stored, so the next save of these rows
            // knows whether the photo has to be written (again).
            if (image !== null) draftPhotoOwner = id;
            else if (draftPhotoOwner === id) draftPhotoOwner = null;
            found = { id, meta: rec.meta, image };
          } else {
            // Written by a build that kept the rows and the photo without ids.
            found = { id: "", meta: rec, image: typeof img === "string" ? img : null };
          }
        } catch {
          found = null;
        }
      }).then(() => found);
    },
    // Resolves false when the browser refused the copy (storage full or not
    // available), so the screen can say that the page exists in this tab only.
    // The photo is written once per review, and again whenever the stored copy
    // turns out not to be this review's any more (another tab discarded or
    // replaced it); the rows are small and written every time.
    save(id: string, meta: unknown, image: string): Promise<boolean> {
      let ok = false;
      return enqueue(async () => {
        try {
          let photoStored = draftPhotoOwner === id;
          if (photoStored) photoStored = draftIdOf(await kv.get(DRAFT_KEY)) === id;
          if (!photoStored) {
            draftPhotoOwner = null;
            await kv.set(DRAFT_IMG_KEY, { id, dataUrl: image });
            draftPhotoOwner = id;
          }
          await kv.set(DRAFT_KEY, { id, meta });
          ok = true;
        } catch {
          ok = false;
        }
      }).then(() => ok);
    },
    clear(id?: string): Promise<void> {
      return enqueue(() => removeDraft(id, "discarded"));
    },
    // Called when any other tab removes a stored copy.
    onCleared(fn: (msg: DraftCleared) => void): () => void {
      draftListeners.add(fn);
      return () => {
        draftListeners.delete(fn);
      };
    },
  };

  function start(): () => void {
    try {
      wire = openWire();
    } catch {
      wire = null;
    }
    wire?.listen((msg) => {
      if (!isObj(msg)) return;
      if (msg.type === "saved" && msg.rev !== rev) void load();
      if (msg.type === "draft-cleared" && typeof msg.id === "string") {
        const cleared: DraftCleared = { id: msg.id, reason: msg.reason === "saved" ? "saved" : "discarded" };
        draftListeners.forEach((fn) => {
          try {
            fn(cleared);
          } catch {
            // one listener failing must not stop the others
          }
        });
      }
    });
    void load();
    return () => {
      try {
        wire?.close();
      } catch {
        // already closed
      }
      wire = null;
    };
  }

  return {
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getSnapshot: (): Snapshot => snap,
    start,
    refresh: load,
    retry: flush,
    mutate,
    addPage,
    restore,
    exportCopy,
    getPageImage,
    draft,
    dismissRecovery: () => emit({ recovery: null }),
    // Only a photo notice can be dismissed. A failed save stays on screen
    // until a save succeeds.
    dismissNotice: () => {
      photoError = null;
      emit({ storageError: errors() });
    },
    // Resolves when every storage job queued so far has finished.
    idle: (): Promise<void> => queue,
  };
}

export type Vault = ReturnType<typeof createVault>;

// ------------------------------------------------------------------ React

export interface Store extends State {
  ready: boolean;
  checks: ChecksResult | null;
  // Set when the browser refused to store something (private mode, quota full).
  storageError: string | null;
  // True when the message is about saving the record itself (retry is offered).
  // False for a photo notice, which can only be dismissed.
  storageErrorIsSave: boolean;
  // True when "try again" could store something (a refused save, or a page
  // photo still held in memory).
  storageErrorCanRetry: boolean;
  // Set when the stored record could not be read in full on load.
  recovery: Recovery | null;
  savePlant: (plant: Plant) => void;
  // Adds a reviewed page. An entry replaces an existing one only when both
  // fill the same slot of the register (see slotKey). Resolves true once the
  // entries are in storage, false when the browser refused the write (they
  // are then on screen only). With `draftId`, that review's stored safety
  // copy is removed once, and only once, the entries are on disk.
  addPage: (page: LogPage | null, entries: LogEntry[], opts?: { draftId?: string }) => Promise<boolean>;
  // Adds one entry typed in by hand, with the same replace-the-slot rule.
  addEntry: (entry: LogEntry) => void;
  updateEntry: (entry: LogEntry) => void;
  deleteEntry: (id: string) => void;
  getPageImage: (pageId: string) => Promise<string | null>;
  // Replaces everything in this browser with a generated sample plant.
  // Returns false when that sample could not be generated.
  loadDemo: (kind: DemoKind) => boolean;
  // Deletes the plant, every entry, every stored photo and any unsaved page.
  reset: () => void;
  retrySave: () => void;
  dismissStorageError: () => void;
  dismissRecovery: () => void;
  // The page under review on the Capture screen (see StoredDraft).
  loadDraft: () => Promise<StoredDraft | null>;
  saveDraft: (id: string, meta: unknown, image: string) => Promise<boolean>;
  // With an id: removes the stored copy only if it is that review's.
  clearDraft: (id?: string) => Promise<void>;
  onDraftCleared: (fn: (msg: DraftCleared) => void) => () => void;
  // Everything on this device as one object: plant, entries, page records and photos.
  exportCopy: () => Promise<Backup>;
  // Replaces everything in this browser with a copy read by readBackup.
  restoreCopy: (copy: BackupRead) => Promise<boolean>;
}

const Ctx = createContext<Store | null>(null);

const idbKv: KV = {
  get: (key) => get(key),
  set: (key, value) => set(key, value),
  update: (key, fn) => update(key, fn),
  keys: () => keys(),
  delMany: (ks) => delMany(ks),
};

function openBroadcast(): Wire | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const ch = new BroadcastChannel("jallog");
  return {
    post: (msg) => ch.postMessage(msg),
    listen: (fn) => {
      ch.onmessage = (e) => fn(e.data);
    },
    close: () => ch.close(),
  };
}

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [vault] = useState(() => createVault(idbKv, openBroadcast));
  // Server render and first client render both see the same "not ready"
  // snapshot, so hydration matches; storage is only touched in the effect.
  const snap = useSyncExternalStore(vault.subscribe, vault.getSnapshot, vault.getSnapshot);

  useEffect(() => {
    const stop = vault.start();
    // Covers browsers without BroadcastChannel and tabs that were frozen in
    // the background: look again whenever this tab comes back into view.
    const look = () => {
      if (document.visibilityState === "visible") void vault.refresh();
    };
    document.addEventListener("visibilitychange", look);
    window.addEventListener("pageshow", look);
    return () => {
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("pageshow", look);
      stop();
    };
  }, [vault]);

  const { plant, entries } = snap.state;
  const checks = useMemo(() => {
    if (!plant) return null;
    try {
      return runChecks(plant, entries);
    } catch (err) {
      // A rule failing must not take the whole record down with it.
      console.error("checks failed", err);
      return null;
    }
  }, [plant, entries]);

  const actions = useMemo(
    () => ({
      savePlant: (p: Plant) => void vault.mutate(ops.savePlant(p)),
      addPage: vault.addPage,
      addEntry: (e: LogEntry) => void vault.mutate(ops.addEntries(null, [e])),
      updateEntry: (e: LogEntry) => void vault.mutate(ops.updateEntry(e)),
      deleteEntry: (id: string) => void vault.mutate(ops.deleteEntry(id)),
      getPageImage: vault.getPageImage,
      loadDemo: (kind: DemoKind) => {
        // Anything that is not exactly "daily" (a click event passed by
        // mistake, say) opens the 3-shift plant.
        const demo = demoState(kind === "daily" ? "daily" : "shift");
        if (!demo) return false;
        void vault.mutate(ops.replaceAll(demo), "photos");
        return true;
      },
      reset: () => {
        void vault.mutate(ops.replaceAll(EMPTY), "all");
        vault.dismissRecovery();
      },
      onDraftCleared: vault.draft.onCleared,
      exportCopy: vault.exportCopy,
      restoreCopy: (copy: BackupRead) => {
        vault.dismissRecovery();
        return vault.restore(copy.state, copy.photos);
      },
      retrySave: () => void vault.retry(),
      dismissStorageError: vault.dismissNotice,
      dismissRecovery: vault.dismissRecovery,
      loadDraft: vault.draft.load,
      saveDraft: vault.draft.save,
      clearDraft: vault.draft.clear,
    }),
    [vault],
  );

  const value = useMemo<Store>(
    () => ({
      ...snap.state,
      ready: snap.ready,
      checks,
      storageError: snap.storageError,
      storageErrorIsSave: snap.storageError === STORAGE_MESSAGE,
      storageErrorCanRetry: snap.retryable,
      recovery: snap.recovery,
      ...actions,
    }),
    [snap, checks, actions],
  );

  // createElement rather than JSX: this file is also loaded by the unit tests.
  return createElement(Ctx.Provider, { value }, children);
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
