"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { FlagList } from "@/components/FlagList";
import { Confirm, Cross } from "@/components/TopBar";
import { COLUMN_ORDER, PARAMS, shiftsFor } from "@/lib/params";
import {
  PRIVACY_COPY, addDays, daysBetween, demoKindOf, fillBlankDates, formatDate, formatDateTime, isIsoDate, localToday, mergeEntries,
  registerKind, saveImpact, slotKey, uid, useStore,
} from "@/lib/store";
import type { DemoKind, StoredDraft } from "@/lib/store";
import { CUT_OFF_NOTE_PREFIX, PARAM_KEYS } from "@/lib/types";
import type { CellMeta, ExtractRequest, ExtractedRow, LogEntry, LogPage, ParamKey, ShiftCode } from "@/lib/types";

interface SamplePage {
  file: string;
  title: string;
  description: string;
  fallbackDate: string;
  plantKind: "STP" | "ETP";
  // Which kind of register the page comes from, and so which sample plant it belongs to.
  plant: DemoKind;
  // The plant named in the page's heading, "" when the sample file does not say.
  plantName: string;
  // The values written on the page (what it was generated from).
  rows: ExtractedRow[];
  // One real answer from the reader for this page, kept in the sample file so
  // the review can be tried, unsure cells and all, when no live reading can be had.
  recorded: { rows: ExtractedRow[]; model: string; label: string; notes: string[]; unmapped: string[] } | null;
}

interface EditRow {
  key: string;
  date: string;
  shift: ShiftCode | "";
  time: string;
  operator: string;
  remarks: string;
  cells: Partial<Record<ParamKey, string>>;
  meta: Partial<Record<ParamKey, CellMeta>>;
  edited: Set<ParamKey>;
}

// A value the reader got wrong on a sample page. Known only for sample pages,
// because only they come with the values they were generated from.
interface Miss {
  rowKey: string; // "" when the reader returned no row for it
  label: string; // "4 Oct, shift B"
  param: ParamKey;
  read: number | null;
  truth: number;
}

interface Review {
  // Ties the rows to their photo in storage and across tabs.
  id: string;
  imageDataUrl: string;
  fileName: string;
  model: string;
  notes: string[];
  unmapped: string[];
  rows: EditRow[];
  columns: ParamKey[];
  // Columns the person has compared with the photo and marked as checked, so
  // their "reader unsure" cells stop counting as still to be confirmed.
  checked: ParamKey[];
  // Set only when a reading of a sample page was compared with its known values.
  accuracy: { matched: number; total: number; rowsRead: number; rowsOnPage: number; misses: Miss[] } | null;
  sample: { title: string; kind: DemoKind; plantName: string } | null;
  // Where the rows came from. "live": read from the photo just now.
  // "recorded": a sample page's earlier reading, kept in the sample file.
  // "known": the values a sample page was generated from; nothing was read.
  source: "live" | "recorded" | "known";
  // For "recorded": when and by which model, as the sample file words it.
  sourceLabel: string;
  // Whether the reader found any operator name / remark on the page. Lets a
  // cell the reviewer emptied be told apart from a page with no such column.
  hadOperator: boolean;
  hadRemarks: boolean;
  fallbackDate: string;
  readAt: string; // ISO
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// The server refuses more than 3 MB of image (app/api/extract/route.ts); stay
// clear of it, so a detailed page is shrunk further here instead of refused there.
const MAX_UPLOAD_BYTES = 2.8 * 1024 * 1024;
const MAX_ROWS = 120;
const MAX_MISSES = 12;
const READ_TIMEOUT_MS = 75_000;
const NOT_CONFIGURED = "Live photo reading is not configured on this server.";
// Stored as the page's "model" when a sample page shows its generating values.
// The word "sample" is in every model name saved for a sample page: the
// report uses it to keep such pages labelled as generated.
const KNOWN_VALUES = "known values of the sample page (not read by the model)";
// A new reading would take the place of the unsaved one in storage.
const UNSAVED_FIRST = "There is an unsaved page waiting above. Continue checking it or discard it before reading another.";
const KIND_TEXT: Record<DemoKind, string> = {
  shift: "a shift register (a row for every shift or reading time)",
  daily: "a daily register (one row a day)",
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, 20) : []);
const shortName = (name: string) => (name.length > 48 ? `${name.slice(0, 45)}…` : name || "the file");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
// Plant names compared without regard to case, spacing or punctuation.
const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ----------------------------------------------------------- photo handling

function fileProblem(f: File): string | null {
  const name = shortName(f.name);
  if (f.size === 0) return `${name} is empty (0 bytes). The photo may not have finished saving. Take it again.`;
  if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
    return `${name} is a PDF, which JalLog does not read yet. Photograph the page, or save it as a JPEG or PNG image.`;
  }
  if (f.type && !f.type.startsWith("image/")) return `${name} is not a photo. Choose a JPEG or PNG image of the register page.`;
  if (f.size > MAX_FILE_BYTES) {
    return `${name} is ${Math.round(f.size / 1024 / 1024)} MB. JalLog reads photos up to 25 MB. Lower the camera resolution or crop the photo to the table, then try again.`;
  }
  return null;
}

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // Some browsers refuse files here that an <img> can still open.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error("not an image"));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

// Phone photos are 3-12 MB; the reader does not need more than ~2000 px. If
// a very detailed page is still too big for the server, shrink it further
// rather than fail.
async function toJpegDataUrl(blob: Blob): Promise<string> {
  const img = await decode(blob);
  try {
    if (!(img.width > 0 && img.height > 0)) throw new Error("empty image");
    for (const [edge, quality] of [[2000, 0.85], [1600, 0.8], [1200, 0.72]] as const) {
      const scale = Math.min(1, edge / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      // A transparent PNG would otherwise come out black in a JPEG.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img.source, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (!url.startsWith("data:image/jpeg;base64,")) throw new Error("could not encode");
      if (url.length * 0.75 <= MAX_UPLOAD_BYTES) return url;
    }
    throw new Error("too large");
  } finally {
    img.close();
  }
}

// ------------------------------------------------------- untrusted answers

// Rows from the server (or the sample file) are checked again here: the
// review table must never be handed a shape it cannot draw.
function cleanRows(raw: unknown): ExtractedRow[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedRow[] = [];
  for (const r of raw.slice(0, MAX_ROWS)) {
    if (!isObj(r)) continue;
    const v = isObj(r.values) ? r.values : {};
    const m = isObj(r.cellMeta) ? r.cellMeta : {};
    const values: ExtractedRow["values"] = {};
    const cellMeta: ExtractedRow["cellMeta"] = {};
    for (const k of PARAM_KEYS) {
      const n = v[k];
      if (typeof n === "number" && Number.isFinite(n)) values[k] = n;
      else if (n === null) values[k] = null;
      const meta = m[k];
      if (isObj(meta) && typeof meta.raw === "string") {
        cellMeta[k] = { raw: meta.raw.slice(0, 80), confidence: meta.confidence === "high" ? "high" : "low" };
      }
    }
    out.push({
      date: str(r.date, 20) || null,
      shift: r.shift === "A" || r.shift === "B" || r.shift === "C" ? r.shift : null,
      time: str(r.time, 8) || null,
      operator: str(r.operator, 60) || null,
      values,
      cellMeta,
      remarks: str(r.remarks) || null,
    });
  }
  return out;
}

function recordedReading(raw: unknown): SamplePage["recorded"] {
  if (!isObj(raw)) return null;
  const rows = cleanRows(raw.rows);
  if (rows.length === 0) return null;
  return {
    rows, model: str(raw.model, 60) || "the vision model", label: str(raw.label, 120) || "a reading recorded earlier",
    notes: strList(raw.notes), unmapped: strList(raw.unmappedColumns),
  };
}

function cleanSamples(raw: unknown): SamplePage[] {
  const pages = isObj(raw) && Array.isArray(raw.pages) ? raw.pages : [];
  const out: SamplePage[] = [];
  for (const p of pages) {
    if (!isObj(p)) continue;
    const file = str(p.file, 80);
    const rows = cleanRows(p.rows);
    // A plain file name only: the value goes into a URL.
    if (!/^[\w.-]+\.(jpe?g|png|webp)$/i.test(file) || rows.length === 0) continue;
    out.push({
      file,
      title: str(p.title, 120) || file,
      description: str(p.description, 600),
      fallbackDate: isIsoDate(p.fallbackDate) ? str(p.fallbackDate) : localToday(),
      plantKind: p.plantKind === "ETP" ? "ETP" : "STP",
      plant: p.plant === "daily" ? "daily" : "shift",
      plantName: str(p.plantName, 80),
      rows,
      recorded: recordedReading(p.recorded),
    });
  }
  return out;
}

type Reading =
  | { ok: true; rows: ExtractedRow[]; model: string; notes: string[]; unmapped: string[] }
  | { ok: false; message: string };

function httpMessage(status: number, ok: boolean): string {
  if (ok) return "The server's answer could not be understood. Reload the page and try again.";
  if (status === 413) return "The photo is too large for the server to accept, even after shrinking. Crop it to the table and try again.";
  if (status === 429) return "Too many pages were sent in a short time. Wait a few minutes and try again.";
  if (status === 408 || status === 504) return "The reader took too long to answer. Try again in a minute.";
  if (status >= 500) return `The server could not read the page just now (error ${status}). Try again in a minute.`;
  return `The server did not accept the photo (error ${status}). Try again, or use a different photo.`;
}

// `stop` is the user's Cancel. "cancelled" is returned only for that; a
// reading that ran out of time is an error with its own message.
async function callReader(body: ExtractRequest, stop: AbortSignal): Promise<Reading | "cancelled"> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, READ_TIMEOUT_MS);
  const onStop = () => ctl.abort();
  stop.addEventListener("abort", onStop);
  if (stop.aborted) ctl.abort();
  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // Read as text first: a proxy or a crashed server answers with an HTML
    // page, and that must become a plain message, not a parsing exception.
    const text = await res.text();
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (isObj(data) && data.ok === true) {
      const rows = cleanRows(data.rows);
      if (rows.length === 0) return { ok: false, message: "No logbook rows were found in this photo. Check that it shows the register page clearly." };
      return { ok: true, rows, model: str(data.model, 60) || "the vision model", notes: strList(data.notes), unmapped: strList(data.unmappedColumns) };
    }
    if (isObj(data) && data.ok === false && str(data.message)) return { ok: false, message: str(data.message) };
    return { ok: false, message: httpMessage(res.status, res.ok) };
  } catch {
    if (stop.aborted && !timedOut) return "cancelled";
    return {
      ok: false,
      message: timedOut
        ? "The reader took more than a minute and was stopped. Try again; a closer, sharper photo of the table reads faster."
        : "The page could not be sent (no connection, or the server is not answering). Check the network and try again.",
    };
  } finally {
    clearTimeout(timer);
    stop.removeEventListener("abort", onStop);
  }
}

// ------------------------------------------------------------ review rows

// "7" on a pH column reads as a typo; show it the way the register would (7.0).
function cellText(k: ParamKey, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "";
  const s = String(v);
  if (!NUMBER_RE.test(s)) return s; // exponent form for a huge number: leave as is
  const d = PARAMS[k].decimals;
  return (s.split(".")[1]?.length ?? 0) < d ? v.toFixed(d) : s;
}

function toEditRows(rows: ExtractedRow[]): EditRow[] {
  return rows.map((r, i) => {
    const cells: EditRow["cells"] = {};
    for (const k of PARAM_KEYS) if (k in r.values) cells[k] = cellText(k, r.values[k]);
    return {
      key: `r${i}`, date: r.date ?? "", shift: r.shift ?? "", time: r.time ?? "",
      operator: r.operator ?? "", remarks: r.remarks ?? "", cells, meta: r.cellMeta, edited: new Set<ParamKey>(),
    };
  });
}

// "4 Oct, shift B" / "29 Sep, 08:00" / "21 Sep" / "row 3"
function rowName(r: { date: string | null; shift: ShiftCode | "" | null; time: string | null }, index: number): string {
  if (!r.date || !isIsoDate(r.date)) return `row ${index + 1}`;
  return `${formatDate(r.date)}${r.shift ? `, shift ${r.shift}` : r.time ? `, ${r.time}` : ""}`;
}

// Compares a live reading of a sample page with the values the page was
// generated from. Rows are paired by date and shift (or time) where the reader
// got those right, and by position otherwise. The values that differ are
// listed, so the review screen can point at the cells a person has to catch.
function scoreAgainstTruth(got: ExtractedRow[], truth: ExtractedRow[]) {
  const keyOf = (r: ExtractedRow) => `${r.date ?? ""}|${r.shift ?? ""}|${r.time ?? ""}`;
  const byKey = new Map<string, number>();
  got.forEach((r, i) => {
    if (!byKey.has(keyOf(r))) byKey.set(keyOf(r), i);
  });
  let matched = 0;
  let total = 0;
  const misses: Miss[] = [];
  truth.forEach((t, i) => {
    const at = byKey.get(keyOf(t)) ?? (i < got.length ? i : -1);
    const row = at >= 0 ? got[at] : undefined;
    for (const k of PARAM_KEYS) {
      const want = t.values[k];
      if (want === null || want === undefined) continue;
      total++;
      const have = row?.values[k];
      if (typeof have === "number" && Math.abs(have - want) < 1e-9) matched++;
      else if (misses.length < MAX_MISSES) {
        // toEditRows keys the review rows "r<index>".
        misses.push({ rowKey: row ? `r${at}` : "", label: rowName(t, i), param: k, read: typeof have === "number" ? have : null, truth: want });
      }
    }
  });
  return { matched, total, rowsRead: got.length, rowsOnPage: truth.length, misses };
}

// null = blank, undefined = not a number
function parseCell(s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  if (!NUMBER_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

// --------------------------------------------------- the page being checked
//
// A reading costs a model call and the corrections cost the user minutes, so
// the page under review is kept twice until it is saved or discarded:
//   - in this module (`session`), which outlives the screen: going to another
//     screen of the app and back never depends on the browser's storage;
//   - in the browser's storage (the "draft"), which outlives a reload.

let fallbackTab = "";
// Marks which tab a draft belongs to, so the tab that was checking a page
// gets it straight back and another tab is asked first.
function tabToken(): string {
  try {
    let t = window.sessionStorage.getItem("jallog:tab");
    if (!t) {
      t = uid("tab");
      window.sessionStorage.setItem("jallog:tab", t);
    }
    return t;
  } catch {
    if (!fallbackTab) fallbackTab = uid("tab");
    return fallbackTab;
  }
}

function packDraft(rv: Review) {
  return {
    v: 1,
    tab: tabToken(),
    // The photo is stored beside this, once, not on every keystroke.
    review: { ...rv, imageDataUrl: "", rows: rv.rows.map((r) => ({ ...r, edited: [...r.edited] })) },
  };
}

// null when the stored copy cannot be shown: not a draft at all, or its photo
// is missing (the store hands back image null when the stored photo belongs
// to a different review).
function reviveDraft(draft: StoredDraft): { tab: string; review: Review } | null {
  const { meta, image } = draft;
  if (!isObj(meta) || meta.v !== 1 || !isObj(meta.review)) return null;
  if (typeof image !== "string" || !image.startsWith("data:image/")) return null;
  const rv = meta.review;
  if (!Array.isArray(rv.rows) || !Array.isArray(rv.columns)) return null;
  const columnList: unknown[] = rv.columns;
  const columns = COLUMN_ORDER.filter((k) => columnList.includes(k));
  const rows: EditRow[] = [];
  const keys = new Set<string>();
  for (const r of rv.rows.slice(0, MAX_ROWS * 2)) {
    if (!isObj(r)) continue;
    const cellsIn = isObj(r.cells) ? r.cells : {};
    const metaIn = isObj(r.meta) ? r.meta : {};
    const editedIn: unknown[] = Array.isArray(r.edited) ? r.edited : [];
    const cells: EditRow["cells"] = {};
    const cellMeta: EditRow["meta"] = {};
    for (const k of PARAM_KEYS) {
      const text = cellsIn[k];
      if (typeof text === "string") cells[k] = text.slice(0, 40);
      const m = metaIn[k];
      if (isObj(m) && typeof m.raw === "string") cellMeta[k] = { raw: m.raw, confidence: m.confidence === "high" ? "high" : "low" };
    }
    let key = str(r.key, 60) || uid("row");
    if (keys.has(key)) key = uid("row");
    keys.add(key);
    rows.push({
      key, date: str(r.date, 20), shift: r.shift === "A" || r.shift === "B" || r.shift === "C" ? r.shift : "",
      time: str(r.time, 8), operator: typeof r.operator === "string" ? r.operator.slice(0, 60) : "",
      remarks: typeof r.remarks === "string" ? r.remarks.slice(0, 300) : "",
      cells, meta: cellMeta, edited: new Set(PARAM_KEYS.filter((k) => editedIn.includes(k))),
    });
  }
  const acc = isObj(rv.accuracy) ? rv.accuracy : null;
  const sample = isObj(rv.sample) ? rv.sample : null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const misses: Miss[] = [];
  for (const m of acc && Array.isArray(acc.misses) ? acc.misses.slice(0, MAX_MISSES) : []) {
    if (!isObj(m) || typeof m.truth !== "number" || !Number.isFinite(m.truth)) continue;
    const param = PARAM_KEYS.find((k) => k === m.param);
    if (!param) continue;
    misses.push({ rowKey: str(m.rowKey, 60), label: str(m.label, 60), param, read: typeof m.read === "number" && Number.isFinite(m.read) ? m.read : null, truth: m.truth });
  }
  const model = str(rv.model, 60) || "the vision model";
  return {
    tab: str(meta.tab, 60),
    review: {
      id: draft.id || str(rv.id, 60) || uid("rv"),
      imageDataUrl: image,
      fileName: str(rv.fileName, 120) || "photo",
      model,
      notes: strList(rv.notes),
      unmapped: strList(rv.unmapped),
      rows,
      columns,
      checked: PARAM_KEYS.filter((k) => Array.isArray(rv.checked) && (rv.checked as unknown[]).includes(k)),
      accuracy: acc && num(acc.total) > 0
        ? { matched: num(acc.matched), total: num(acc.total), rowsRead: num(acc.rowsRead), rowsOnPage: num(acc.rowsOnPage), misses }
        : null,
      sample: sample ? { title: str(sample.title, 120), kind: sample.kind === "daily" ? "daily" : "shift", plantName: str(sample.plantName, 80) } : null,
      source: rv.source === "recorded" || rv.source === "known" ? rv.source : "live",
      sourceLabel: str(rv.sourceLabel, 120),
      hadOperator: rv.hadOperator === true,
      hadRemarks: rv.hadRemarks === true,
      fallbackDate: isIsoDate(rv.fallbackDate) ? str(rv.fallbackDate) : localToday(),
      readAt: str(rv.readAt, 40),
    },
  };
}

function clockTime(iso: string): string {
  const when = formatDateTime(iso);
  return when ? `on ${when}` : "earlier";
}

type ReadResult =
  | { kind: "review"; review: Review }
  | { kind: "error"; message: string }
  // Another tab left an unsaved page in storage after this screen was opened.
  | { kind: "waiting"; review: Review }
  | { kind: "cancelled" };

interface Flight {
  label: string;
  startedAt: number;
  // The shrunk photo, once it has been made, to show while the reader works.
  photo: string | null;
  cancel: () => void;
}

// Lives as long as the tab, not the screen. A read still in flight when the
// user goes to another screen is shown as such when they come back, and its
// result is delivered here instead of being written over whatever is in
// storage by then.
const session: {
  review: Review | null;
  flight: Flight | null;
  // What a read that ended in something other than a review has to tell the screen.
  result: ReadResult | null;
  // Reviews saved to the log from this tab whose entries may not be on disk
  // yet. Their stored copy is the fallback for a reload, not a page waiting.
  saved: Set<string>;
  listeners: Set<() => void>;
} = { review: null, flight: null, result: null, saved: new Set(), listeners: new Set() };

const tell = () => session.listeners.forEach((fn) => fn());

interface ReadJob {
  blob: () => Promise<Blob>;
  fileName: string;
  sample: SamplePage | null;
  plantKind: "STP" | "ETP";
  apiReady: boolean | null;
  stop: AbortSignal;
  onPhoto: (dataUrl: string) => void;
}

// Photo in, review out. Touches no screen state, so it can finish after the
// screen that started it has gone.
async function readPage(job: ReadJob): Promise<ReadResult> {
  const { sample, fileName, stop } = job;
  let blob: Blob;
  try {
    blob = await job.blob();
  } catch {
    if (stop.aborted) return { kind: "cancelled" };
    return { kind: "error", message: "The sample page could not be loaded. Check the connection and try again." };
  }
  let imageDataUrl: string;
  try {
    imageDataUrl = await toJpegDataUrl(blob);
  } catch {
    return {
      kind: "error",
      message: sample
        ? "The sample page could not be opened in this browser."
        : `${shortName(fileName)} could not be opened as a photo. Use a JPEG or PNG (on an iPhone, set Camera → Formats → Most Compatible, or share the photo as JPEG).`,
    };
  }
  if (stop.aborted) return { kind: "cancelled" };
  job.onPhoto(imageDataUrl);

  const fallbackDate = sample?.fallbackDate ?? localToday();
  // apiReady is null while the first check is still out; try the reader
  // then, and let its own answer say if it is not configured.
  const reading =
    job.apiReady === false
      ? ({ ok: false, message: NOT_CONFIGURED } as const)
      : await callReader({ imageDataUrl, plantKind: job.plantKind, fallbackDate }, stop);
  if (reading === "cancelled") return { kind: "cancelled" };

  let rows: ExtractedRow[];
  let model: string;
  let notes: string[];
  let unmapped: string[] = [];
  let accuracy: Review["accuracy"] = null;
  let source: Review["source"] = "live";
  let sourceLabel = "";
  if (reading.ok) {
    ({ rows, model, notes, unmapped } = reading);
    if (sample) {
      const score = scoreAgainstTruth(rows, sample.rows);
      if (score.total > 0) accuracy = score;
    }
  } else if (sample?.recorded) {
    // Keep the walkthrough usable without the model: a real answer the reader
    // gave for this page earlier, said to be exactly that.
    const rec = sample.recorded;
    rows = rec.rows;
    model = `${rec.model} (recorded sample reading)`;
    source = "recorded";
    sourceLabel = rec.label;
    unmapped = rec.unmapped;
    notes = [`${reading.message} Showing a reading of this sample page that was made earlier and kept with it (${rec.label}). Nothing was read just now.`, ...rec.notes];
    const score = scoreAgainstTruth(rows, sample.rows);
    if (score.total > 0) accuracy = score;
  } else if (sample) {
    // No recorded reading either: the generator's own values, and a plain
    // statement that nothing was read from the photo.
    rows = sample.rows;
    model = KNOWN_VALUES;
    source = "known";
    notes = [`${reading.message} Showing the values this sample page was generated from. Nothing was read from the photo.`];
  } else {
    return { kind: "error", message: reading.message };
  }

  const columns = COLUMN_ORDER.filter((k) => rows.some((r) => (r.values[k] !== null && r.values[k] !== undefined) || r.cellMeta[k]));
  return {
    kind: "review",
    review: {
      id: uid("rv"), imageDataUrl, fileName: shortName(fileName), model, notes, unmapped, rows: toEditRows(rows), columns: [...columns], checked: [],
      accuracy, sample: sample ? { title: sample.title, kind: sample.plant, plantName: sample.plantName } : null, source, sourceLabel,
      hadOperator: rows.some((r) => r.operator), hadRemarks: rows.some((r) => r.remarks),
      fallbackDate, readAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------- screen

interface Saved {
  rows: number;
  // Rows of the page that landed on a slot already in the log, and how many
  // saved entries left the log for them.
  replaced: number;
  removed: number;
  daily: boolean;
  pageId: string;
  entryIds: Set<string>;
  // Flag ids before the save, to tell what this page changed.
  flagsBefore: Set<string>;
  // null while the write is still out; false when the browser refused it.
  stored: boolean | null;
}

interface Problem {
  key: string;
  text: string;
  // data-jump token of the first control to go to.
  jump?: string;
}

function Check() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 6.5l2.4 2.4 4.6-5.3" />
    </svg>
  );
}

export default function Capture() {
  const {
    ready, plant, entries, checks, storageErrorIsSave, addPage, loadDemo, loadDraft, saveDraft, clearDraft, onDraftCleared,
  } = useStore();
  const [samples, setSamples] = useState<SamplePage[]>([]);
  const [apiReady, setApiReady] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Starts from the page this tab already has in hand, so coming back from
  // another screen shows it at once, whatever the browser's storage did.
  const [review, setReview] = useState<Review | null>(() => session.review);
  const [restored, setRestored] = useState(false);
  const [waiting, setWaiting] = useState<Review | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [mismatch, setMismatch] = useState<SamplePage | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<"top" | "bottom" | null>(null);
  const [confirmSave, setConfirmSave] = useState<"top" | "bottom" | null>(null);
  const [confirmDemo, setConfirmDemo] = useState<DemoKind | null>(null);
  // null = not chosen yet: the first row's date comes from the page.
  const [fillFrom, setFillFrom] = useState<string | null>(null);
  // null = not chosen yet: zoomed on a phone, fitted on a wide screen.
  const [zoom, setZoom] = useState<boolean | null>(null);
  const [follow, setFollow] = useState(true);
  const [over, setOver] = useState(false);
  // Whether the browser took the safety copy of the page under review.
  const [draftKept, setDraftKept] = useState<boolean | null>(null);
  // Set when another tab removed the stored copy of the page open here.
  const [elsewhere, setElsewhere] = useState<"saved" | "discarded" | null>(null);
  const [focusCell, setFocusCell] = useState<{ rowKey: string; param: ParamKey } | null>(null);
  // True while the table has columns out of sight to the right.
  const [more, setMore] = useState(false);
  const [narrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches);
  const [, force] = useReducer((x: number) => x + 1, 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const lastRow = useRef(-1);
  // The newest review not yet handed to storage, and the review whose copy
  // has been asked for at least once.
  const dirty = useRef<Review | null>(null);
  const asked = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/samples/truth.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setSamples(cleanSamples(d)); })
      .catch(() => {});
    fetch("/api/extract")
      .then((r) => r.json())
      .then((d) => { if (live) setApiReady(Boolean(isObj(d) && d.ready)); })
      .catch(() => { if (live) setApiReady(false); });
    return () => { live = false; };
  }, []);

  // Follow the session: a read that started before this screen was (re)opened
  // shows as "Reading", and its result arrives here.
  useEffect(() => {
    const sync = () => {
      force();
      const res = session.result;
      if (res) {
        session.result = null;
        if (res.kind === "error") setError(res.message);
        if (res.kind === "waiting") {
          setWaiting(res.review);
          setNote(UNSAVED_FIRST);
        }
      }
      const rv = session.review;
      if (rv) setReview((cur) => cur ?? rv);
    };
    session.listeners.add(sync);
    sync();
    return () => {
      session.listeners.delete(sync);
    };
  }, []);

  // Bring back a page that was being checked when the tab was last reloaded
  // or closed. Not needed when this tab still has a page, or a read, in hand.
  useEffect(() => {
    if (!ready || session.review || session.flight) return;
    let live = true;
    loadDraft().then((d) => {
      if (!live || !d || session.review || session.saved.has(d.id)) return;
      const found = reviveDraft(d);
      if (!found) {
        // Rows without their own photo cannot be checked against anything.
        void clearDraft(d.id || undefined);
        setNote(
          "A page that was being checked could not be brought back: its photo was not stored with it (storage was full, or another tab replaced it). Nothing from that page was added to the log. Read the page again.",
        );
        return;
      }
      if (found.tab === tabToken() && !session.flight) {
        session.review = found.review;
        setReview((cur) => cur ?? found.review);
        setRestored(true);
      } else {
        setWaiting(found.review);
      }
    });
    return () => { live = false; };
  }, [ready, loadDraft, clearDraft]);

  const persist = useCallback((rv: Review) => {
    void saveDraft(rv.id, packDraft(rv), rv.imageDataUrl).then((ok) => {
      if (session.review?.id === rv.id) setDraftKept(ok);
    });
  }, [saveDraft]);

  // Keep the stored copy in step with the table. A new page goes in at once;
  // edits are batched so typing does not write on every key.
  useEffect(() => {
    if (!review) return;
    session.review = review;
    dirty.current = review;
    const first = asked.current !== review.id;
    const t = setTimeout(() => {
      dirty.current = null;
      asked.current = review.id;
      persist(review);
    }, first ? 0 : 400);
    return () => clearTimeout(t);
  }, [review, persist]);

  // Leaving the screen inside the batching window: write what is waiting.
  useEffect(() => {
    return () => {
      const rv = dirty.current;
      dirty.current = null;
      if (rv && session.review?.id === rv.id) void saveDraft(rv.id, packDraft(rv), rv.imageDataUrl);
    };
  }, [saveDraft]);

  // Things that belong to one page under review start again with the next.
  const reviewId = review?.id ?? null;
  useEffect(() => {
    setFillFrom(null);
    setZoom(null);
    setConfirmDiscard(null);
    setConfirmSave(null);
    setDraftKept(null);
    setElsewhere(null);
    setFocusCell(null);
    lastRow.current = -1;
  }, [reviewId]);

  // Another tab removed the stored copy of a page. If it is the one open
  // here, store it again and say so; if it is the one offered as "waiting",
  // stop offering it.
  useEffect(() => {
    return onDraftCleared((msg) => {
      const rv = session.review;
      if (rv && msg.id === rv.id) {
        setElsewhere(msg.reason);
        void saveDraft(rv.id, packDraft(rv), rv.imageDataUrl).then(setDraftKept);
      } else {
        setWaiting((w) => (w && w.id === msg.id ? null : w));
      }
    });
  }, [onDraftCleared, saveDraft]);


  // A file dropped outside the drop area would make the browser open it in
  // place of the app. Swallow file drops everywhere on this screen.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  // The seconds counter under "Reading the page".
  const flying = session.flight !== null;
  useEffect(() => {
    if (!flying) return;
    const t = setInterval(force, 1000);
    return () => clearInterval(t);
  }, [flying]);

  // Closing or reloading the tab mid-edit (the draft write may not finish) or
  // mid-read (the reading would be lost with the tab): ask first.
  const hasReview = review !== null;
  useEffect(() => {
    if (!hasReview && !flying) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasReview, flying]);

  // Is part of the table out of sight to the right?
  const measure = useCallback(() => {
    const el = wrapRef.current;
    setMore(el ? el.scrollLeft + el.clientWidth < el.scrollWidth - 8 : false);
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, review]);

  const perDay = plant?.shiftsPerDay;
  const daily = perDay === 1;

  const analysis = useMemo(() => {
    const p = { low: 0, invalid: 0, undated: 0, badTime: 0, duplicates: 0, oddDates: 0, ahead: 0, unplaced: 0, blank: 0, slotIgnored: 0 };
    const dup = new Set<string>();
    // Unsure cells still to be confirmed, per column.
    const lowBy = new Map<ParamKey, number>();
    // Saved values corrected by hand that this page would overwrite: "rowKey|param" -> the saved value.
    const overwrites = new Map<string, number | null>();
    const none = { replaces: 0, removed: 0, crowded: [], corrections: [] } as ReturnType<typeof saveImpact>;
    if (!review) return { p, dup, lowBy, overwrites, impact: none, startNeeded: false, layoutClash: null as null | "time" | "shift" };
    const firstRowOf = new Map<string, string>();
    const today = localToday();
    let datedAbove = false;
    let startNeeded = false;
    const asEntries: Pick<LogEntry, "date" | "shift" | "time" | "values">[] = [];
    for (const r of review.rows) {
      const time = !daily && TIME_RE.test(r.time) ? r.time : null;
      const shift = daily ? null : r.shift || null;
      if (!isIsoDate(r.date)) {
        p.undated++;
        if (!datedAbove) startNeeded = true;
      } else {
        datedAbove = true;
        const k = slotKey({ date: r.date, shift, time }, perDay);
        if (k === null) p.unplaced++;
        else if (firstRowOf.has(k)) {
          p.duplicates++;
          dup.add(r.key);
          dup.add(firstRowOf.get(k)!);
        } else firstRowOf.set(k, r.key);
        const age = daysBetween(r.date, today);
        if (age < -1 || age > 400) p.oddDates++;
        // The same line the checks draw (the "ahead" rule): any date after
        // today, except a night-shift row dated tomorrow once that shift has begun.
        else if (age < 0 && !(shift === "C" && new Date().getHours() >= 22)) p.ahead++;
      }
      if (!daily && r.time && !TIME_RE.test(r.time)) p.badTime++;
      if (daily && (r.shift || r.time)) p.slotIgnored++;
      let filled = false;
      const values: LogEntry["values"] = {};
      for (const k of review.columns) {
        const v = parseCell(r.cells[k] ?? "");
        if (v === undefined) p.invalid++;
        else {
          values[k] = v;
          if (v !== null) filled = true;
          if (r.meta[k]?.confidence === "low" && !r.edited.has(k) && !review.checked.includes(k)) {
            p.low++;
            lowBy.set(k, (lowBy.get(k) ?? 0) + 1);
          }
        }
      }
      if (!filled && !r.remarks.trim()) p.blank++;
      asEntries.push({ date: r.date, shift, time, values });
    }
    const impact = saveImpact(entries, asEntries, perDay);
    for (const c of impact.corrections) {
      const row = review.rows[c.row];
      if (row) overwrites.set(`${row.key}|${c.param}`, c.saved);
    }
    // A page whose rows are marked by clock time, saved into a log whose rows
    // are all marked by shift letter (or the reverse), fills the same days a
    // second time and every check then sees gaps. It usually means the page
    // is from a different register.
    let layoutClash: null | "time" | "shift" = null;
    if (!daily && entries.length > 0) {
      const logShift = entries.some((e) => e.shift);
      const logTime = entries.some((e) => !e.shift && e.time);
      const pageShift = asEntries.some((e) => e.shift);
      const pageTime = asEntries.some((e) => !e.shift && e.time);
      if (logShift && !logTime && pageTime && !pageShift) layoutClash = "time";
      if (logTime && !logShift && pageShift && !pageTime) layoutClash = "shift";
    }
    return { p, dup, lowBy, overwrites, impact, startNeeded, layoutClash };
  }, [review, entries, perDay, daily]);

  if (!ready) return null;

  // ---- reading a photo

  function start(label: string, fileName: string, sample: SamplePage | null, blob: () => Promise<Blob>, plantKind: "STP" | "ETP") {
    if (session.flight) return;
    setError(null);
    setNote(null);
    setSaved(null);
    setMismatch(null);
    const ctl = new AbortController();
    const flight: Flight = { label, startedAt: Date.now(), photo: null, cancel: () => ctl.abort() };
    session.flight = flight;
    tell();
    const run = async (): Promise<ReadResult> => {
      // Another tab may have left an unsaved page since this screen was
      // opened. Reading now would write over its stored copy, so offer it first.
      const stray = await loadDraft();
      if (stray && !session.saved.has(stray.id)) {
        const found = reviveDraft(stray);
        if (found) return { kind: "waiting", review: found.review };
      }
      return readPage({
        blob, fileName, sample, plantKind, apiReady, stop: ctl.signal,
        onPhoto: (dataUrl) => {
          flight.photo = dataUrl;
          tell();
        },
      });
    };
    void run()
      .catch((): ReadResult => ({ kind: "error", message: "Something went wrong while reading the page. Try again." }))
      .then((res) => {
        session.flight = null;
        if (res.kind === "review") {
          session.review = res.review;
          // No screen is open to take it: store the safety copy from here.
          if (session.listeners.size === 0) void saveDraft(res.review.id, packDraft(res.review), res.review.imageDataUrl);
        } else if (res.kind !== "cancelled") {
          session.result = res;
        }
        tell();
      });
  }

  function onFiles(files: FileList | null) {
    const list = files ? Array.from(files) : [];
    if (list.length === 0) return;
    if (session.flight) {
      setNote("Still reading the previous page. Add the next one when this is done.");
      return;
    }
    if (waiting) {
      setNote(UNSAVED_FIRST);
      return;
    }
    const f = list[0];
    const problem = fileProblem(f);
    if (problem) {
      setError(problem);
      setSaved(null);
      return;
    }
    if (apiReady === false) {
      setError(`${NOT_CONFIGURED} Your own photos cannot be read here; the sample pages below still open.`);
      return;
    }
    start("Reading the page…", f.name, null, async () => f, plant?.kind ?? "STP");
    if (list.length > 1) setNote(`Only the first of the ${list.length} files is being read. Add the others one at a time.`);
  }

  function openSample(s: SamplePage) {
    start(
      "Reading the sample page…", s.file, s,
      async () => {
        const res = await fetch(`/samples/${encodeURIComponent(s.file)}`);
        if (!res.ok) throw new Error("missing");
        return res.blob();
      },
      s.plantKind,
    );
  }

  function pickSample(s: SamplePage) {
    if (session.flight) return;
    if (waiting) {
      setNote(UNSAVED_FIRST);
      return;
    }
    // A daily-register page saved into a 3-shift plant (or the reverse) would
    // fill the log with rows that match nothing. Offer the right plant instead.
    if (plant && registerKind(plant) !== s.plant) {
      setError(null);
      setMismatch(s);
      return;
    }
    openSample(s);
  }

  function switchAndOpen(s: SamplePage) {
    setMismatch(null);
    if (!loadDemo(s.plant)) {
      setError("The matching sample plant is not available in this build, so this page cannot be opened here.");
      return;
    }
    openSample(s);
  }

  function openDemo(kind: DemoKind) {
    setConfirmDemo(null);
    if (!loadDemo(kind)) setError("That sample plant is not available in this build.");
  }

  // ---- no plant yet

  if (!plant) {
    return (
      <div className="stack">
        {error && <div className="notice bad" role="alert">{error}</div>}
        <div className="card">
          <h2>Choose a plant first</h2>
          <p style={{ color: "var(--ink-2)", margin: "4px 0 14px" }}>
            Readings are checked against a plant&apos;s consent limits, so a page needs a plant to belong to.
            {review && " The page you were checking is kept and will come back once a plant is chosen."}
          </p>
          {confirmDemo ? (
            <Confirm
              text={`${entries.length} stored ${plural(entries.length, "entry has", "entries have")} no plant and will be replaced by the sample plant. Download the CSV from the Log screen first if you need ${plural(entries.length, "it", "them")}.`}
              no="Cancel" yes="Replace with the sample plant" danger
              onNo={() => setConfirmDemo(null)} onYes={() => openDemo(confirmDemo)}
            />
          ) : (
            <div className="row">
              {/* Entries without a plant come from a damaged record; opening a sample over them is asked about first. */}
              <button className="btn primary" onClick={() => (entries.length > 0 ? setConfirmDemo("shift") : openDemo("shift"))}>Open the 3-shift sample plant</button>
              <button className="btn" onClick={() => (entries.length > 0 ? setConfirmDemo("daily") : openDemo("daily"))}>Open the daily-register sample plant</button>
              <Link className="btn" href="/plant">Set up my plant</Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- checking a reading

  function patchRow(key: string, patch: Partial<EditRow>) {
    setReview((rv) => rv && { ...rv, rows: rv.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  }

  function patchCell(row: EditRow, k: ParamKey, value: string) {
    patchRow(row.key, { cells: { ...row.cells, [k]: value }, edited: new Set(row.edited).add(k) });
  }

  // A new row continues the register: the next day for a daily register, the
  // next shift (rolling over to the next day) for a shift register.
  function addRow() {
    const key = uid("row");
    setReview((rv) => {
      if (!rv) return rv;
      const last = rv.rows[rv.rows.length - 1];
      let date = last ? last.date : rv.fallbackDate;
      let shift: ShiftCode | "" = "";
      if (last && daily) date = addDays(date, 1);
      else if (last && last.shift) {
        const cycle = shiftsFor(perDay ?? 3);
        const at = cycle.indexOf(last.shift);
        if (at >= 0 && at < cycle.length - 1) shift = cycle[at + 1];
        else {
          shift = cycle[0];
          date = addDays(date, 1);
        }
      }
      const row: EditRow = { key, date, shift, time: "", operator: "", remarks: "", cells: {}, meta: {}, edited: new Set() };
      return { ...rv, rows: [...rv.rows, row] };
    });
  }

  function markChecked(cols: ParamKey[]) {
    setReview((rv) => rv && { ...rv, checked: PARAM_KEYS.filter((c) => rv.checked.includes(c) || cols.includes(c)) });
  }

  // Leaves the review. The stored copy goes too, unless the page was just
  // saved: then the store removes it once the entries are on disk.
  function closeReview(discard: boolean) {
    const id = review?.id;
    dirty.current = null;
    session.review = null;
    setReview(null);
    setRestored(false);
    if (discard && id) void clearDraft(id);
  }

  // Scrolls to, and focuses, the first control with this problem.
  function jump(token: string) {
    const el = document.querySelector<HTMLElement>(`.review [data-jump~="${token}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "center" });
    el.focus({ preventScroll: true });
  }

  // Moves the photo to about where this row is on the page. An estimate: it
  // assumes the table runs down most of the page under a heading, which is
  // how registers are ruled. The switch beside the photo turns it off.
  function panTo(index: number, count: number) {
    const el = photoRef.current;
    if (!follow || !el || count <= 0 || index === lastRow.current) return;
    lastRow.current = index;
    const room = el.scrollHeight - el.clientHeight;
    if (room <= 0) return;
    const at = (0.18 + 0.7 * ((index + 0.5) / count)) * el.scrollHeight - el.clientHeight / 2;
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: Math.max(0, Math.min(room, at)), behavior: calm ? "auto" : "smooth" });
  }

  const { p, dup, lowBy, overwrites, impact, layoutClash } = analysis;
  const n = review ? review.rows.length : 0;
  const problems: Problem[] = [];
  if (review) {
    if (n === 0) problems.push({ key: "none", text: "No rows are left. Add a row, or discard this page." });
    if (p.invalid > 0) problems.push({ key: "invalid", jump: "invalid", text: `${p.invalid} ${plural(p.invalid, "cell is", "cells are")} not a number. Fix or clear ${plural(p.invalid, "it", "them")}.` });
    if (p.undated > 0) problems.push({ key: "undated", jump: "undated", text: `${p.undated} ${plural(p.undated, "row has", "rows have")} no valid date.` });
    if (p.badTime > 0) problems.push({ key: "badtime", jump: "badtime", text: `${p.badTime} ${plural(p.badTime, "row has", "rows have")} a time that is not in 24-hour HH:MM form (for example 08:00 or 20:30).` });
    if (p.duplicates > 0) {
      problems.push({
        key: "dup", jump: "dup",
        text: `${p.duplicates} ${plural(p.duplicates, "row repeats", "rows repeat")} ${daily ? "a date" : "a date and shift"} used higher up this page. Correct the date${daily ? "" : " or shift"}, or remove the extra row.`,
      });
    }
    if (p.blank > 0) problems.push({ key: "blank", jump: "blank", text: `${p.blank} ${plural(p.blank, "row has", "rows have")} no reading and no remark. Fill ${plural(p.blank, "it", "them")} in or remove ${plural(p.blank, "it", "them")}.` });
    if (p.low > 0) problems.push({ key: "low", jump: "low", text: `${p.low} ${plural(p.low, "cell", "cells")} the reader was not sure of ${plural(p.low, "has", "have")} not been confirmed.` });
  }
  const blocked = !review || problems.length > 0;
  // A sample page that names a plant other than the one open: saving it mixes two plants' records.
  const otherPlant =
    review?.sample && review.sample.plantName && demoKindOf(plant) !== null && !sameName(review.sample.plantName, plant.name)
      ? review.sample.plantName
      : null;
  // Saving is asked about first when the page looks like another register's.
  const askBeforeSave = otherPlant !== null || layoutClash !== null;

  function save() {
    if (!review || !plant || blocked) return;
    const now = new Date().toISOString();
    const page: LogPage = {
      id: uid("page"), plantId: plant.id, uploadedAt: now, fileName: review.fileName,
      imageDataUrl: review.imageDataUrl,
      // A page saved from a generated sample says so for good, whoever read it.
      model: review.sample && !/\bsample\b/i.test(review.model) ? `${review.model} (sample page)` : review.model,
      notes: review.notes, reviewedAt: now,
    };
    // An empty Operator or Remarks cell means "cleared by the reviewer" when
    // the page has such a column, and "not on this page" when it has none.
    const hasOperator = review.hadOperator || review.rows.some((r) => r.operator.trim());
    const hasRemarks = review.hadRemarks || review.rows.some((r) => r.remarks.trim());
    const out: LogEntry[] = review.rows.map((r) => {
      const values: LogEntry["values"] = {};
      for (const k of review.columns) {
        const v = parseCell(r.cells[k] ?? "");
        // A blank cell is stored as null, not left out: it says "this column
        // is on the page and the cell is empty", which is what lets a second
        // page for the same day add its columns without wiping these.
        if (v !== undefined) values[k] = v;
      }
      return {
        id: uid("e"), plantId: plant.id, date: r.date,
        // A daily register has no shifts: its slot is the date alone.
        shift: daily ? null : r.shift || null,
        time: daily ? null : r.time || null,
        operator: r.operator.trim() || (hasOperator ? "" : null), values, remarks: r.remarks.trim() || (hasRemarks ? "" : null),
        pageId: page.id, cellMeta: r.meta, edited: review.columns.filter((k) => r.edited.has(k)), capturedAt: now,
      };
    });
    const removed = mergeEntries(entries, out, perDay).replaced.length;
    const reviewId = review.id;
    // From here the stored copy of this review is a fallback for a reload,
    // not a page waiting to be saved.
    session.saved.add(reviewId);
    const done = addPage(page, out, { draftId: reviewId });
    setSaved({
      rows: out.length, replaced: impact.replaces, removed, daily, pageId: page.id, entryIds: new Set(out.map((e) => e.id)),
      flagsBefore: new Set((checks?.flags ?? []).map((f) => f.id)), stored: null,
    });
    setError(null);
    setNote(null);
    closeReview(false);
    void done.then((ok) => {
      if (ok) session.saved.delete(reviewId);
      setSaved((s) => (s && s.pageId === page.id ? { ...s, stored: ok } : s));
    });
  }

  if (review) {
    const showTime = !daily && (review.rows.some((r) => r.time) || review.rows.every((r) => !r.shift));
    const spare = COLUMN_ORDER.filter((k) => !review.columns.includes(k));
    const demoKind = demoKindOf(plant);
    const ownPlant = demoKind === null;
    const cutOff = review.notes.filter((t) => t.startsWith(CUT_OFF_NOTE_PREFIX));
    const otherNotes = review.notes.filter((t) => !t.startsWith(CUT_OFF_NOTE_PREFIX));
    const zoomed = zoom ?? narrow;
    const fillStart = fillFrom ?? review.fallbackDate;
    const missOf = new Map<string, Miss>();
    for (const m of review.accuracy?.misses ?? []) if (m.rowKey) missOf.set(`${m.rowKey}|${m.param}`, m);
    const unsure = [...lowBy.keys()];

    // Things to know before saving that do not stop the save. `warn` items make the box yellow.
    const cautions: { key: string; warn: boolean; body: React.ReactNode }[] = [];
    for (const c of impact.crowded) {
      cautions.push({
        key: `crowded-${c.date}`, warn: true,
        body: (
          <>
            <b>{formatDate(c.date)} has {c.count} saved entries{c.shifts.length > 0 ? ` (${c.shifts.length === c.count ? "shifts " : ""}${c.shifts.join(", ")})` : ""}.</b>{" "}
            Saving this page combines them into one row; where they disagree only the first is kept. Download the CSV from the Log screen first if you need them.
          </>
        ),
      });
    }
    if (otherPlant) {
      cautions.push({
        key: "other-plant", warn: true,
        body: <><b>This sample page is from {otherPlant}, not {plant.name}.</b> It is here to try the reader on a different layout. Saving it would mix two plants&apos; records and leave gaps in this log; discard it when you have looked.</>,
      });
    }
    if (review.sample && ownPlant) {
      cautions.push({ key: "sample-own", warn: true, body: <>This is a generated sample page, not a page from {plant.name}. Saving adds its rows to {plant.name}&apos;s log.</> });
    }
    if (!review.sample && !ownPlant) {
      cautions.push({
        key: "real-in-sample", warn: true,
        body: <>This page will be saved into the sample plant, whose other readings are generated. For a real register, set up your own plant on the <Link href="/plant" style={{ textDecoration: "underline" }}>Plant screen</Link> first; this page is kept while you do.</>,
      });
    }
    if (layoutClash) {
      cautions.push({
        key: "layout", warn: true,
        body: layoutClash === "time"
          ? <>The rows on this page are marked by clock time, but every entry saved for {plant.name} is marked by shift letter. They will not line up, and the checks would count shifts as missing on these dates. Check that this page is from {plant.name}&apos;s register.</>
          : <>The rows on this page are marked by shift letter, but every entry saved for {plant.name} is marked by clock time. They will not line up. Check that this page is from {plant.name}&apos;s register.</>,
      });
    }
    if (impact.corrections.length > 0) {
      const c = impact.corrections.length;
      cautions.push({
        key: "corrections", warn: true,
        body: (
          <>
            {c} saved {plural(c, "value", "values")} on {plural(c, "this date was", "these dates were")} corrected by hand and {plural(c, "differs", "differ")} from this reading (underlined in the table).
            Saving replaces {plural(c, "it", "them")} with what is in the table. To keep a correction, type it into the table.{" "}
            <button type="button" className="linkish" onClick={() => jump("overwrite")}>Show the first</button>
          </>
        ),
      });
    }
    if (p.unplaced > 0) {
      cautions.push({
        key: "unplaced", warn: true,
        body: (
          <>
            {p.unplaced} {plural(p.unplaced, "row has", "rows have")} neither a shift nor a time, so JalLog cannot tell which part of the day {plural(p.unplaced, "it covers", "they cover")}.
            Reading this page again later would add {plural(p.unplaced, "it", "them")} a second time. Choose a shift where the page shows one. If this register has one row a day,
            set Shifts per day to 1 on the Plant screen.
          </>
        ),
      });
    }
    if (p.ahead > 0) {
      cautions.push({ key: "ahead", warn: true, body: <>{p.ahead} {plural(p.ahead, "row is", "rows are")} dated tomorrow. If the page really says so, save {plural(p.ahead, "it", "them")} as read: the checks will list {plural(p.ahead, "it", "them")} as dated after the page was photographed, which is something to verify, not an error. If the date was misread, correct it here.</> });
    }
    if (p.oddDates > 0) {
      cautions.push({ key: "odd", warn: true, body: <>{p.oddDates} {plural(p.oddDates, "row is", "rows are")} dated in the future or more than a year back. Check the year was read correctly.</> });
    }
    if (impact.replaces > 0) {
      const r = impact.replaces;
      cautions.push({
        key: "replaces", warn: false,
        body: daily
          ? <>{r} {plural(r, "row is for a date", "rows are for dates")} already in the log. The columns on this page replace the saved values for {plural(r, "that date", "those dates")}; columns this page does not have (the facing page of the register, say) are kept.</>
          : <>{r} {plural(r, "row", "rows")} will replace {plural(r, "the entry", "entries")} already in the log for the same date and shift.</>,
      });
    }
    if (p.slotIgnored > 0) {
      cautions.push({ key: "slot", warn: false, body: <>{plant.name} keeps one row a day, so the shift letters and times read from this page are not saved.</> });
    }
    const yellow = cautions.some((c) => c.warn);

    const actions = (where: "top" | "bottom") =>
      confirmDiscard === where ? (
        <Confirm
          text="Discard this page? The rows read from it, and your corrections, will be lost."
          no="Keep checking" yes="Discard page" danger
          onNo={() => setConfirmDiscard(null)} onYes={() => closeReview(true)}
        />
      ) : confirmSave === where && askBeforeSave && !blocked ? (
        <Confirm
          text={
            otherPlant
              ? `This page is from ${otherPlant}, not ${plant.name}. Saving it would mix two plants' records.`
              : `The rows on this page are marked by ${layoutClash === "time" ? "clock time" : "shift letter"}, and every entry saved for ${plant.name} by ${layoutClash === "time" ? "shift letter" : "clock time"}. Saving would put a second set of rows on the same dates, and the checks would then report gaps. It looks like a page from another register.`
          }
          no="Do not save" yes={`Save into ${plant.name} anyway`} danger
          onNo={() => setConfirmSave(null)} onYes={save}
        />
      ) : (
        <div className="row">
          <button className="btn" onClick={() => { setConfirmSave(null); setConfirmDiscard(where); }}>Discard</button>
          <button
            className="btn primary" disabled={blocked}
            onClick={() => {
              if (askBeforeSave) {
                setConfirmDiscard(null);
                setConfirmSave(where);
              } else save();
            }}
          >
            Save {n} {plural(n, "row", "rows")}
          </button>
        </div>
      );

    const focusRow = focusCell ? review.rows.findIndex((r) => r.key === focusCell.rowKey) : -1;
    const focusMeta = focusCell && focusRow >= 0 ? review.rows[focusRow].meta[focusCell.param] : undefined;
    const focusKey = focusCell ? `${focusCell.rowKey}|${focusCell.param}` : "";

    return (
      <div className="stack">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>Check the reading</h1>
            <p>
              {review.source === "known"
                ? `${n} ${plural(n, "row", "rows")} shown for ${review.fileName}: the values this sample page was generated from. Nothing was read from the photo.`
                : review.source === "recorded"
                  ? `${n} ${plural(n, "row", "rows")} from an earlier reading of ${review.fileName}, kept with the sample page${review.sourceLabel ? ` (${review.sourceLabel})` : ""}. Nothing was read just now.`
                  : `${n} ${plural(n, "row", "rows")} read from ${review.fileName} by ${review.model}.`}{" "}
              {review.accuracy &&
                `Sample page check: ${review.source === "recorded" ? "that reading" : "the reading"} matched ${review.accuracy.matched} of the ${review.accuracy.total} values written on the page (${((review.accuracy.matched / review.accuracy.total) * 100).toFixed(1)}%). `}
              Compare with the photo and correct anything that is wrong. Nothing is added to the log until you save.
            </p>
          </div>
          {actions("top")}
        </div>

        {restored && (
          <div className="notice" role="status">
            This page was still being checked when the screen was left. It has been brought back as it was; nothing from it is in the log yet.
          </div>
        )}
        {elsewhere && (
          <div className="notice warn" role="status">
            {elsewhere === "saved"
              ? "This page was saved to the log from another tab. It is still open here: saving it again replaces those rows, or discard it here if that save was the one you wanted."
              : "Another tab discarded the stored copy of this page. It is still open here, and its copy has been stored again."}
          </div>
        )}
        {draftKept === false && (
          <div className="notice bad" role="alert">
            This browser could not keep a safety copy of this page (storage is full or not available). The page stays here while this tab is open,
            but a reload or closing the tab would lose it. Save it before then.
          </div>
        )}
        {/* Said first and in red: rows below the cut exist on paper only. */}
        {cutOff.map((text, i) => <div className="notice bad" role="alert" key={i}><b>Part of the page is missing below.</b> {text}</div>)}

        {problems.length > 0 && (
          <div className="notice bad" id="cannot-save">
            <b>Cannot save yet</b>
            <ul>
              {problems.map((it) => (
                <li key={it.key}>
                  {it.text}{" "}
                  {it.jump && <button type="button" className="linkish" onClick={() => jump(it.jump!)}>Go to the first</button>}
                </li>
              ))}
            </ul>
            {p.undated > 0 && (
              <div className="fix">
                <div className="row">
                  {analysis.startNeeded && (
                    <label className="row small" style={{ gap: 6 }}>
                      Date of the first row
                      <input className="date-in" type="date" value={fillStart} onChange={(e) => setFillFrom(e.target.value)} />
                    </label>
                  )}
                  <button
                    className="btn sm" disabled={analysis.startNeeded && !isIsoDate(fillStart)}
                    onClick={() => setReview((rv) => rv && { ...rv, rows: fillBlankDates(rv.rows, fillStart, perDay) })}
                  >
                    Fill the blank dates
                  </button>
                </div>
                <p className="small">
                  {daily
                    ? "Each undated row gets the day after the row above it."
                    : "An undated row takes the date of the row above it, moving on a day when the shift letter or the time starts again."}{" "}
                  Check the result against the photo.
                </p>
              </div>
            )}
            {p.duplicates > 0 && daily && (
              <p className="small fix">
                {plant.name} is set to one row a day. If this register has a row for every shift, change Shifts per day on the Plant screen first.
              </p>
            )}
            {p.low > 0 && (
              <div className="fix">
                <p className="small">
                  The yellow cells are ones the reader was not sure of: an unclear digit, or a value it converted (grams written on the page, kilograms stored).
                  Compare each with the photo. Correct it, or when a column matches the photo press the tick in its heading.
                </p>
                <div className="row" style={{ marginTop: 6 }}>
                  <button type="button" className="btn sm" onClick={() => markChecked(unsure)}>
                    I have compared {p.low === 1 ? "it" : `all ${p.low}`} with the photo: mark as checked
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {review.checked.length > 0 && (
          <p className="small" style={{ color: "var(--ink-2)" }}>
            Marked as checked against the photo: {review.checked.map((k) => PARAMS[k].label).join(", ")}.{" "}
            <button type="button" className="linkish" onClick={() => setReview((rv) => rv && { ...rv, checked: [] })}>Show them as unsure again</button>
          </p>
        )}
        {cautions.length > 0 && (
          <div className={`notice ${yellow ? "warn" : ""}`}>
            {cautions.length === 1 ? cautions[0].body : (
              <>
                <b>Before you save</b>
                <ul>{cautions.map((c) => <li key={c.key}>{c.body}</li>)}</ul>
              </>
            )}
          </div>
        )}

        <div className="review">
          <div className="photo-pane">
            <div className={`photo ${zoomed ? "zoom" : ""}`} ref={photoRef}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={review.imageDataUrl} alt="Photographed logbook page" onClick={() => setZoom(!zoomed)} />
            </div>
            <div className="row photo-tools">
              <button className="btn sm" onClick={() => setZoom(!zoomed)} aria-pressed={zoomed}>{zoomed ? "Fit photo" : "Zoom photo"}</button>
              <label className="row small" style={{ gap: 6, flexWrap: "nowrap" }} title="Moves the photo to about where the row being checked is on the page. An estimate: scroll the photo if it is off.">
                <input type="checkbox" checked={follow} onChange={(e) => { lastRow.current = -1; setFollow(e.target.checked); }} />
                Photo follows the row being checked
              </label>
            </div>
            {/* Pinned with the photo, so the column of the cell in hand is named even when the
                table heading has scrolled away. It also says what a hover text would: touch and
                keyboard users get no hover. */}
            <p className="cell-info small" aria-hidden={!focusCell}>
              {focusCell && focusRow >= 0 ? (
                <>
                  <b>Row {focusRow + 1}, {PARAMS[focusCell.param].label}{PARAMS[focusCell.param].unit ? ` (${PARAMS[focusCell.param].unit})` : ""}.</b>{" "}
                  {focusMeta && `Written on page: “${focusMeta.raw}”${focusMeta.confidence === "low" ? " (reader unsure)" : ""}.`}
                  {overwrites.has(focusKey) && ` Saved in the log, corrected by hand: ${overwrites.get(focusKey) ?? "blank"}.`}
                  {missOf.has(focusKey) && ` The sample page says ${missOf.get(focusKey)!.truth}.`}
                </>
              ) : "Select a cell to see what was written on the page for it."}
            </p>
          </div>

          <div>
            <p className="legend-cells small">
              <span><i className="sw low" aria-hidden />Yellow, bar on the left: reader unsure</span>
              <span><i className="sw edited" aria-hidden />Blue outline: changed by you</span>
              <span><i className="sw invalid" aria-hidden />Red: not a number, a repeated row, or a value that cannot be a real reading (kept as written, and raised under Flags)</span>
              {(overwrites.size > 0 || missOf.size > 0) && <span><i className="sw mark" aria-hidden />Underlined: differs from {overwrites.size > 0 ? "a hand-corrected saved value" : "the sample page's known value"}</span>}
            </p>
            <div className={`table-shade ${more ? "more" : ""}`}>
              <div className="table-wrap" ref={wrapRef} onScroll={measure}>
                <table className="data">
                  <thead>
                    <tr>
                      <th className="l c-row">Row</th>
                      <th className="l c-date">Date</th>
                      {!daily && <th className="l">Shift</th>}
                      {showTime && <th className="l">Time</th>}
                      {review.columns.map((k) => {
                        const count = lowBy.get(k) ?? 0;
                        return (
                          <th key={k}>
                            {PARAMS[k].short}<small>{PARAMS[k].unit || " "}</small>
                            {count > 0 && (
                              <button
                                type="button" className="th-check"
                                aria-label={`Mark the ${PARAMS[k].label} column as checked against the photo (${count} unsure ${plural(count, "cell", "cells")})`}
                                title="This column matches the photo: mark it as checked"
                                onClick={() => markChecked([k])}
                              >
                                <Check />{count}
                              </button>
                            )}
                          </th>
                        );
                      })}
                      <th className="l">Operator</th>
                      <th className="l">Remarks</th>
                      <th><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.rows.map((r, idx) => {
                      const clash = dup.has(r.key);
                      const dated = isIsoDate(r.date);
                      const empty = !r.remarks.trim() && review.columns.every((k) => parseCell(r.cells[k] ?? "") == null);
                      const dateJump = [!dated && "undated", clash && "dup", empty && "blank"].filter(Boolean).join(" ");
                      return (
                        <tr key={r.key} onFocus={() => panTo(idx, n)}>
                          <td className="l c-row">
                            <span className="muted">{idx + 1}</span> {dated ? formatDate(r.date) : "no date"}{!daily && (r.shift || r.time) ? ` ${r.shift || r.time}` : ""}
                          </td>
                          <td className="tight l c-date">
                            <input
                              className={`cell text date ${dated && !clash ? "" : "invalid"}`} type="date"
                              value={r.date} aria-label={`Date, row ${idx + 1}`} data-jump={dateJump || undefined}
                              aria-invalid={!dated || clash}
                              onChange={(e) => patchRow(r.key, { date: e.target.value })}
                            />
                          </td>
                          {!daily && (
                            <td className="tight l">
                              <select
                                className={`cell-select ${clash ? "invalid" : ""}`} value={r.shift} aria-label={`Shift, row ${idx + 1}`}
                                onChange={(e) => patchRow(r.key, { shift: e.target.value as ShiftCode | "" })}
                              >
                                <option value="">–</option>
                                <option value="A">A</option>
                                <option value="B">B</option>
                                <option value="C">C</option>
                              </select>
                            </td>
                          )}
                          {showTime && (
                            <td className="tight l">
                              <input
                                className={`cell text time ${r.time && !TIME_RE.test(r.time) ? "invalid" : ""}`} value={r.time}
                                placeholder="HH:MM" maxLength={5} inputMode="numeric" aria-label={`Time, row ${idx + 1}`}
                                data-jump={r.time && !TIME_RE.test(r.time) ? "badtime" : undefined}
                                onChange={(e) => patchRow(r.key, { time: e.target.value.trim() })}
                              />
                            </td>
                          )}
                          {review.columns.map((k) => {
                            const text = r.cells[k] ?? "";
                            const v = parseCell(text);
                            const impossible = typeof v === "number" && (v < PARAMS[k].physicalMin || v > PARAMS[k].physicalMax);
                            const isLow = v !== undefined && r.meta[k]?.confidence === "low" && !r.edited.has(k) && !review.checked.includes(k);
                            const cellKey = `${r.key}|${k}`;
                            const overwrite = overwrites.has(cellKey);
                            const miss = !r.edited.has(k) ? missOf.get(cellKey) : undefined;
                            const cls =
                              v === undefined || impossible ? "invalid"
                              : r.edited.has(k) ? "edited"
                              : isLow ? "low" : "";
                            const state =
                              v === undefined ? ", not a number"
                              : impossible ? ", outside the possible range"
                              : r.edited.has(k) ? ", changed by you"
                              : isLow ? ", reader unsure" : "";
                            const tokens = [v === undefined && "invalid", isLow && "low", overwrite && "overwrite"].filter(Boolean).join(" ");
                            return (
                              <td className="tight" key={k}>
                                <input
                                  className={`cell ${cls} ${overwrite || miss ? "mark" : ""}`} inputMode="decimal" value={text} maxLength={16}
                                  aria-label={`${PARAMS[k].label}, row ${idx + 1}${state}${r.meta[k] && isLow ? `, written on page: ${r.meta[k]!.raw}` : ""}`}
                                  aria-invalid={v === undefined} data-jump={tokens || undefined}
                                  title={
                                    impossible ? `Outside the possible range for ${PARAMS[k].label}. Saved as written and flagged.`
                                    : r.meta[k] ? `Written on page: "${r.meta[k]!.raw}"` : undefined
                                  }
                                  onFocus={() => setFocusCell({ rowKey: r.key, param: k })}
                                  onChange={(e) => patchCell(r, k, e.target.value)}
                                />
                              </td>
                            );
                          })}
                          <td className="tight l">
                            <input className="cell text" value={r.operator} maxLength={60} aria-label={`Operator, row ${idx + 1}`} onChange={(e) => patchRow(r.key, { operator: e.target.value })} />
                          </td>
                          <td className="tight l">
                            <input className="cell wide" value={r.remarks} maxLength={300} aria-label={`Remarks, row ${idx + 1}`} onChange={(e) => patchRow(r.key, { remarks: e.target.value })} />
                          </td>
                          <td className="tight">
                            <button
                              className="btn sm" aria-label={`Remove row ${idx + 1}`} title="Remove row"
                              onClick={() => setReview((rv) => rv && { ...rv, rows: rv.rows.filter((x) => x.key !== r.key) })}
                            >
                              <Cross />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {n === 0 && (
                      <tr><td className="l muted" colSpan={review.columns.length + 7}>No rows.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            {more && <p className="small" style={{ color: "var(--ink-2)", marginTop: 4 }}>More columns to the right: scroll the table sideways. The Row column stays in view.</p>}

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={addRow}>Add a row</button>
              {spare.length > 0 && (
                <select
                  className="cell-select boxed" value="" aria-label="Add a column the reader missed"
                  onChange={(e) => {
                    const k = e.target.value as ParamKey;
                    if (PARAM_KEYS.includes(k)) setReview((rv) => rv && { ...rv, columns: COLUMN_ORDER.filter((c) => rv.columns.includes(c) || c === k) });
                  }}
                >
                  <option value="">Add a column the reader missed…</option>
                  {spare.map((k) => <option key={k} value={k}>{PARAMS[k].label}</option>)}
                </select>
              )}
            </div>
          </div>
        </div>

        {review.accuracy && review.accuracy.matched < review.accuracy.total && (
          <div className="notice">
            <b>Where the reading differs from the sample page.</b> This list is possible only because a sample page comes with the values it was
            generated from; on a real page these are the cells the review exists to catch.
            <ul>
              {review.accuracy.misses.map((m, i) => (
                <li key={i}>{m.label}, {PARAMS[m.param].label}: read {m.read === null ? "nothing" : m.read}, the page says {m.truth}</li>
              ))}
            </ul>
            {review.accuracy.total - review.accuracy.matched > review.accuracy.misses.length &&
              <p className="small">And {review.accuracy.total - review.accuracy.matched - review.accuracy.misses.length} more.</p>}
            {review.accuracy.rowsRead !== review.accuracy.rowsOnPage &&
              <p className="small">The reader returned {review.accuracy.rowsRead} rows; the page has {review.accuracy.rowsOnPage}.</p>}
          </div>
        )}
        {otherNotes.map((text, i) => <div className="notice" key={i}>{text}</div>)}
        {review.unmapped.length > 0 && (
          <p className="small" style={{ color: "var(--ink-2)" }}>Columns on the page that JalLog does not track yet: {review.unmapped.join(", ")}.</p>
        )}

        {/* The same actions again, so the last row checked is next to Save. */}
        <div className="page-head review-foot" style={{ marginBottom: 0 }}>
          <p>
            {blocked
              ? <>Cannot save yet. <a href="#cannot-save" style={{ textDecoration: "underline" }}>See what has to be fixed</a>.</>
              : "Nothing is added to the log until you save."}
          </p>
          {actions("bottom")}
        </div>
      </div>
    );
  }

  // ---- adding a page

  const current = registerKind(plant);
  const flight = session.flight;
  const busy = flight !== null;
  const seconds = flight ? Math.max(0, Math.floor((Date.now() - flight.startedAt) / 1000)) : 0;
  const allFlags = checks?.flags ?? [];
  const touched = saved ? allFlags.filter((f) => !saved.flagsBefore.has(f.id) || (f.entryIds ?? []).some((id) => saved.entryIds.has(id))) : [];
  const cleared = saved ? [...saved.flagsBefore].filter((id) => !allFlags.some((f) => f.id === id)).length : 0;
  // The write was refused and the browser is still refusing. Once a retry
  // gets through (the banner at the top goes), the rows are stored after all.
  const notStored = saved?.stored === false && storageErrorIsSave;
  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Add a logbook page</h1>
          <p>
            One photo of the register page, taken straight on with the whole table in frame. Every value is shown beside the photo for you to
            check, anything the reader was unsure of has to be confirmed, and nothing is saved until you press Save.
          </p>
        </div>
      </div>

      {saved !== null && (
        <div className="card">
          <div className={`notice ${notStored ? "bad" : ""}`} role="status">
            {notStored
              ? `${saved.rows} ${plural(saved.rows, "row is", "rows are")} in the log on this screen, but this browser has not stored ${plural(saved.rows, "it", "them")} yet (see the message at the top of the page). The checked page is kept as a safety copy until ${plural(saved.rows, "it is", "they are")} stored: after a reload it comes back here to be saved again.`
              : `${saved.rows} ${plural(saved.rows, "row", "rows")} saved to the log and checked.`}
            {saved.replaced > 0 &&
              (saved.daily
                ? ` ${saved.replaced} ${plural(saved.replaced, "was", "were")} merged into the ${plural(saved.replaced, "entry", "entries")} already saved for the same ${plural(saved.replaced, "date", "dates")}.`
                : ` ${saved.replaced} replaced ${plural(saved.replaced, "an earlier entry", "earlier entries")} for the same date and shift.`)}
            {saved.removed > saved.replaced && ` ${saved.removed} saved entries were combined into ${saved.replaced} ${plural(saved.replaced, "row", "rows")}.`}
          </div>
          <div className="card-head" style={{ marginTop: 14 }}>
            <h2>What the checks found on this page</h2>
            <Link className="sub" href={`/flags?page=${encodeURIComponent(saved.pageId)}`} style={{ textDecoration: "underline" }}>See all flags</Link>
          </div>
          {!checks ? (
            <p className="notice bad">The checks could not run on this record. This is a fault in JalLog, not a clean result.</p>
          ) : touched.length === 0 ? (
            <p style={{ color: "var(--ink-2)" }}>No flag was raised by this page, and none of its rows is part of one.</p>
          ) : (
            <>
              <p style={{ color: "var(--ink-2)", marginBottom: 10 }}>
                {touched.length} {plural(touched.length, "flag was raised by this page or includes one of its rows", "flags were raised by this page or include its rows")}.
                Each is something to verify, not a finding.
              </p>
              <FlagList flags={touched} />
            </>
          )}
          {checks && cleared > 0 && (
            <p className="small" style={{ color: "var(--ink-2)", marginTop: 10 }}>
              {cleared} earlier {plural(cleared, "flag no longer applies", "flags no longer apply")} now that these rows are in the log.
            </p>
          )}
        </div>
      )}
      {error && <div className="notice bad" role="alert">{error}</div>}
      {note && <div className="notice warn" role="status">{note}</div>}
      {apiReady === false && (
        <div className="notice warn">
          {NOT_CONFIGURED} Your own photos cannot be read here. The sample pages below still open: with a reading that was made earlier
          and kept with the page where there is one, and otherwise with the values the page was generated from. Each says which.
        </div>
      )}

      {waiting && !busy && (
        <div className="notice" role="status">
          <p>
            A page from {waiting.fileName}, read {clockTime(waiting.readAt)}, was never saved or discarded
            ({waiting.rows.length} {plural(waiting.rows.length, "row", "rows")}). It may be open in another tab.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn sm primary"
              onClick={() => { session.review = waiting; setReview(waiting); setRestored(true); setWaiting(null); setNote(null); }}
            >
              Continue checking it
            </button>
            <button className="btn sm" onClick={() => { const id = waiting.id; setWaiting(null); setNote(null); void clearDraft(id); }}>Discard it everywhere</button>
          </div>
        </div>
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); if (!busy) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}
      >
        {flight ? (
          <div className="drop reading" role="status">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {flight.photo && <img src={flight.photo} alt="The page being read" />}
            <div className="row" style={{ justifyContent: "center" }}>
              <div className="spinner" aria-hidden />
              <b>{flight.label}</b>
              {/* The count changes every second; a screen reader hears only the label. */}
              <span aria-hidden style={{ color: "var(--ink-2)", fontVariantNumeric: "tabular-nums" }}>{seconds} s</span>
            </div>
            <span className="muted small">Usually 10 to 25 seconds for a full page, up to a minute when the reader is busy. You can look at other screens meanwhile; the reading comes back here.</span>
            <button className="btn sm" onClick={flight.cancel}>Cancel</button>
          </div>
        ) : (
          <div className={`drop ${over ? "over" : ""}`}>
            <b>Photograph or choose the page</b>
            <span className="small" style={{ maxWidth: "70ch", color: "var(--ink-2)" }}>
              JPEG or PNG, one page at a time. {PRIVACY_COPY} Do not upload pages you are not allowed to share.
            </span>
            <input
              ref={fileRef} type="file" accept="image/*" hidden tabIndex={-1} aria-hidden
              onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }}
            />
            <button className="btn primary" onClick={() => fileRef.current?.click()} disabled={apiReady === false}>Take / choose photo</button>
          </div>
        )}
      </div>

      {mismatch && (
        <Confirm
          text={
            `"${mismatch.title}" is a page from ${KIND_TEXT[mismatch.plant]}. ${plant.name} is set up as ${KIND_TEXT[current]}, so the rows would not line up with its log. ` +
            `JalLog can open the matching sample plant and read the page there. ` +
            (demoKindOf(plant)
              ? "That replaces the sample plant open now."
              : `That replaces ${plant.name} and its ${entries.length} ${plural(entries.length, "entry", "entries")} in this browser; download a full copy from the Plant screen first if you need them.`)
          }
          no="Cancel" yes="Switch sample plant and read the page" danger={demoKindOf(plant) === null && entries.length > 0}
          onNo={() => setMismatch(null)} onYes={() => switchAndOpen(mismatch)}
        />
      )}

      {samples.length > 0 && !busy && (
        <div>
          <div className="card-head" style={{ margin: "6px 2px 10px" }}>
            <h2>No register to hand? Try a sample page</h2>
            <span className="sub">generated pages with known values</span>
          </div>
          <div className="samples">
            {samples.map((s) => (
              <button className="sample" key={s.file} onClick={() => pickSample(s)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/samples/${encodeURIComponent(s.file)}`} alt="" loading="lazy" />
                <div>
                  <b>{s.title}</b>
                  <span className="tag" style={{ margin: "4px 0", display: "inline-block" }}>{s.plant === "daily" ? "daily register" : "shift register"}</span>
                  <span>{s.description}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
