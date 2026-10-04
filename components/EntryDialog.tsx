"use client";

// One entry of the log, opened from the Log screen: every field can be
// corrected, beside the photo it was read from and the record of how it was
// digitised. The same dialog, empty, adds an entry by hand.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FlagList, logLink } from "@/components/FlagList";
import { Cross } from "@/components/TopBar";
import { COLUMN_ORDER, PARAMS } from "@/lib/params";
import { daysBetween, formatDate, formatDateTime, isIsoDate, localToday, slotKey, uid } from "@/lib/store";
import { PARAM_KEYS, READER_NOTE_PREFIX } from "@/lib/types";
import type { CellMeta, Flag, LogEntry, LogPage, ParamKey, Plant, Severity, ShiftCode } from "@/lib/types";
import styles from "./EntryDialog.module.css";

// ---------------------------------------------------------------- pure helpers
// Exported so they can be tested without a browser. Saved data is treated as
// untrusted: an entry written by an older version, or damaged in storage, may
// have any field missing or of the wrong type.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// Plain decimal notation only. Number() would also take "1e3", "0x1F" and
// "Infinity", none of which is what a logbook cell says.
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const SHIFT_CODES: ShiftCode[] = ["A", "B", "C"];
const KNOWN_PARAMS = new Set<string>(PARAM_KEYS);
const ODD_DATE_DAYS = 400;
export const EMPTY_ENTRY_MESSAGE = "Enter at least one reading or a remark. To remove this entry, use Delete entry.";
export const NO_SLOT_MESSAGE = "No shift or time is given, so this entry cannot be matched to a shift of the register.";

// "" for anything that is not text or a number.
export function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

// A stored reading: a finite number, or null for blank / damaged.
export function cleanNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// What the person typed: null = blank, undefined = not a number.
export function parseCell(s: string): number | null | undefined {
  const t = text(s).trim();
  if (!t) return null;
  if (!NUMBER_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

// "7" in a pH box reads as a typo; show it the way the register would (7.0).
export function cellText(k: ParamKey, v: unknown): string {
  const n = cleanNumber(v);
  if (n === null) return "";
  const s = String(n);
  if (s.includes("e")) return s;
  const d = PARAMS[k].decimals;
  return (s.split(".")[1]?.length ?? 0) < d ? n.toFixed(d) : s;
}

function sameValue(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-9;
}

function outsidePhysical(k: ParamKey, v: number): boolean {
  return v < PARAMS[k].physicalMin || v > PARAMS[k].physicalMax;
}

type Slot = { date?: unknown; shift?: unknown; time?: unknown };

// Which shift (or day) of the register an entry stands for; two entries with
// the same key would be the same row of the paper book. null = cannot be told.
// The store owns the rule (slotKey), because it is also what decides which
// entry a save replaces. It is called loosely and its answer checked, so a
// change to that function cannot break this screen; when it gives no key, a
// one-row-a-day register is keyed on its date alone.
export function entrySlot(e: Slot, shiftsPerDay: number): string | null {
  const date = text(e.date);
  if (!isIsoDate(date)) return null;
  const shift = SHIFT_CODES.includes(e.shift as ShiftCode) ? (e.shift as ShiftCode) : null;
  const time = text(e.time) || null;
  let key: unknown = null;
  try {
    key = (slotKey as unknown as (x: unknown, perDay?: unknown) => unknown)({ date, shift, time }, shiftsPerDay);
  } catch {
    key = null;
  }
  if (typeof key === "string" && key) return key;
  const slot = shift ?? time;
  if (slot) return `${date}|${slot}`;
  return shiftsPerDay === 1 ? `${date}|day` : null;
}

// "12 Sep 2026, shift A" / "12 Sep 2026, 08:00" / "12 Sep 2026".
export function entryLabel(e: Slot): string {
  const date = formatDate(text(e.date).slice(0, 24), { day: "numeric", month: "short", year: "numeric" });
  const shift = text(e.shift);
  const time = text(e.time);
  return `${date}${shift ? `, shift ${shift.slice(0, 8)}` : time ? `, ${time.slice(0, 8)}` : ""}`;
}

export interface Draft {
  date: string;
  shift: ShiftCode | "";
  time: string;
  operator: string;
  remarks: string;
  cells: Partial<Record<ParamKey, string>>;
}

export function draftFrom(entry: LogEntry | null, fallbackDate: string): Draft {
  if (!entry) return { date: fallbackDate, shift: "", time: "", operator: "", remarks: "", cells: {} };
  const cells: Draft["cells"] = {};
  const values = entry.values && typeof entry.values === "object" ? entry.values : {};
  for (const k of PARAM_KEYS) {
    const s = cellText(k, values[k]);
    if (s) cells[k] = s;
  }
  const date = text(entry.date);
  return {
    // A date input cannot show a malformed date; the dialog says what was stored.
    date: isIsoDate(date) ? date : "",
    shift: SHIFT_CODES.includes(entry.shift as ShiftCode) ? (entry.shift as ShiftCode) : "",
    time: text(entry.time),
    operator: text(entry.operator),
    remarks: text(entry.remarks),
    cells,
  };
}

// Parameters a person changed at an earlier review, minus anything unknown.
export function editedBefore(entry: LogEntry | null): ParamKey[] {
  const list: unknown[] = Array.isArray(entry?.edited) ? (entry.edited as unknown[]) : [];
  return PARAM_KEYS.filter((k) => list.includes(k));
}

// True when two forms show the same thing. A box that was never typed in and
// a box that was typed in and cleared again are both blank.
export function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.date === b.date && a.shift === b.shift && a.time === b.time && a.operator === b.operator && a.remarks === b.remarks &&
    PARAM_KEYS.every((k) => (a.cells[k] ?? "") === (b.cells[k] ?? ""))
  );
}

// The entry can be saved somewhere else (another tab) while a form is open on
// it. `initial` is what the form showed when it opened and `current` is what
// is saved now: every box the person has not touched takes the saved text,
// every box they did touch keeps what they typed.
export function rebaseDraft(draft: Draft, initial: Draft, current: Draft): Draft {
  const cells: Draft["cells"] = {};
  for (const k of PARAM_KEYS) {
    const mine = draft.cells[k] ?? "";
    const touched = mine !== (initial.cells[k] ?? "");
    const s = touched ? mine : current.cells[k] ?? "";
    if (s !== "" || draft.cells[k] !== undefined) cells[k] = s;
  }
  return {
    date: draft.date === initial.date ? current.date : draft.date,
    shift: draft.shift === initial.shift ? current.shift : draft.shift,
    time: draft.time === initial.time ? current.time : draft.time,
    operator: draft.operator === initial.operator ? current.operator : draft.operator,
    remarks: draft.remarks === initial.remarks ? current.remarks : draft.remarks,
    cells,
  };
}

// Turns the form into the entry to store. `keys` are the parameters shown in
// the form; values of parameters not shown are carried over untouched.
// Cells that are not numbers are left as they were: the caller refuses to save
// while any exist (see checkDraft).
//
// `initial` is the text the form opened with. Only boxes that differ from it
// are written; the rest keep whatever `original` (the entry as saved now)
// holds, so a form left open cannot undo a correction saved from another tab.
export function buildEntry(
  form: Draft,
  original: LogEntry | null,
  plantId: string,
  keys: ParamKey[],
  now: string,
  newId: string,
  initial?: Draft,
): { entry: LogEntry; changed: ParamKey[] } {
  const saved = original ? draftFrom(original, "") : null;
  const draft = saved ? rebaseDraft(form, initial ?? saved, saved) : form;
  const stored = original?.values && typeof original.values === "object" ? original.values : {};
  const values: LogEntry["values"] = {};
  // Drop damaged values (NaN, text) rather than carry them forward.
  for (const [k, v] of Object.entries(stored)) {
    if (cleanNumber(v) !== null) (values as Record<string, number>)[k] = v as number;
  }
  const changed: ParamKey[] = [];
  for (const k of keys) {
    const v = parseCell(draft.cells[k] ?? "");
    if (v === undefined) continue;
    if (v === null) delete values[k];
    else values[k] = v;
    if (!sameValue(cleanNumber(stored[k]), v)) changed.push(k);
  }
  const fields = {
    date: draft.date,
    shift: draft.shift || null,
    time: draft.time.trim() || null,
    operator: draft.operator.trim() || null,
    remarks: draft.remarks.trim() || null,
    values,
  };
  if (!original) {
    // Typed in by hand: there is no reader to disagree with, so nothing counts
    // as "changed during review" yet.
    return { entry: { id: newId, plantId, ...fields, pageId: null, edited: [], capturedAt: now }, changed: [] };
  }
  const earlier = editedBefore(original);
  const edited = PARAM_KEYS.filter((k) => earlier.includes(k) || changed.includes(k));
  return { entry: { ...original, ...fields, edited }, changed };
}

export interface DraftCheck {
  errors: string[]; // each one blocks saving
  warnings: string[]; // worth a second look, do not block
  invalid: ParamKey[]; // cells that are not numbers
  impossible: ParamKey[]; // numbers outside the physical range
  // The entry already holding the date and shift this one is being moved to
  // (or added at). Blocks saving.
  clash: LogEntry | null;
  // How many other entries already share this entry's own date and shift.
  // Does not block: the place was not changed, so a correction must save.
  sharing: number;
}

export function checkDraft(
  draft: Draft,
  original: LogEntry | null,
  others: LogEntry[],
  shiftsPerDay: number,
  keys: ParamKey[],
  today: string,
): DraftCheck {
  const out: DraftCheck = { errors: [], warnings: [], invalid: [], impossible: [], clash: null, sharing: 0 };
  const dateOk = isIsoDate(draft.date);
  if (!dateOk) out.errors.push("Choose a valid date.");
  if (draft.time && !TIME_RE.test(draft.time.trim())) {
    out.errors.push("Write the time in 24-hour HH:MM form (for example 08:00 or 20:30), or leave it blank.");
  }

  let filled = 0;
  for (const k of keys) {
    const v = parseCell(draft.cells[k] ?? "");
    if (v === undefined) out.invalid.push(k);
    else if (v !== null) {
      filled++;
      if (outsidePhysical(k, v)) out.impossible.push(k);
    }
  }
  if (out.invalid.length) {
    out.errors.push(
      `${out.invalid.map((k) => PARAMS[k].label).join(", ")}: not a number. Use digits and a decimal point, or clear the box.`,
    );
  }
  if (filled === 0 && !draft.remarks.trim() && out.invalid.length === 0) {
    out.errors.push(EMPTY_ENTRY_MESSAGE);
  }

  if (dateOk) {
    const slot = entrySlot(draft, shiftsPerDay);
    if (slot !== null) {
      const id = original?.id;
      const mates = (Array.isArray(others) ? others : []).filter((e) => e && e.id !== id && entrySlot(e, shiftsPerDay) === slot);
      // Taking a place that is already filled is refused. An entry that was
      // already sharing its place is not: the log can hold several entries for
      // one date (two facing pages saved before the plant was set to one row a
      // day, say), and each of them must stay correctable.
      const moved = !original || entrySlot(original, shiftsPerDay) !== slot;
      if (mates.length > 0 && moved) {
        out.clash = mates[0];
        out.errors.push(
          `The log already has an entry for ${entryLabel(out.clash)}. Open that entry to correct it, or change the date${shiftsPerDay === 1 ? "" : " or shift"} here.`,
        );
      } else if (mates.length > 0) {
        out.sharing = mates.length;
        const place = entryLabel(shiftsPerDay === 1 ? { date: draft.date } : draft);
        out.warnings.push(
          `${mates.length === 1 ? "One other entry is" : `${mates.length} other entries are`} also saved for ${place}. Saving here changes only this entry. If they are the same row of the register, copy any missing readings into one of them and delete the ${mates.length === 1 ? "other" : "others"}.`,
        );
      }
    } else if (!original || entrySlot(original, shiftsPerDay) !== null) {
      out.warnings.push(NO_SLOT_MESSAGE);
    }
    const age = daysBetween(draft.date, today);
    if (Number.isFinite(age) && (age < -1 || age > ODD_DATE_DAYS)) {
      out.warnings.push("The date is in the future or more than a year back. Check the year.");
    }
  }
  if (out.impossible.length) {
    out.warnings.push(
      `${out.impossible.map((k) => PARAMS[k].label).join(", ")}: outside what the parameter can physically be. It will be saved as written, so the record matches the paper, and raised under Flags.`,
    );
  }
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function formatWhen(iso: unknown): string {
  return formatDateTime(text(iso)) || "not recorded";
}

function limitText(k: ParamKey, lim: { min?: number; max?: number } | undefined): string | null {
  const lo = cleanNumber(lim?.min);
  const hi = cleanNumber(lim?.max);
  if (lo === null && hi === null) return null;
  const u = PARAMS[k].unit ? ` ${PARAMS[k].unit}` : "";
  if (lo !== null && hi !== null) return `Consent limit ${lo} to ${hi}${u}`;
  return hi !== null ? `Consent limit: max ${hi}${u}` : `Consent limit: min ${lo}${u}`;
}

function metaOf(entry: LogEntry | null): Partial<Record<ParamKey, CellMeta>> {
  const m = entry?.cellMeta;
  return m && typeof m === "object" ? m : {};
}

// ------------------------------------------------- flags in the Log table
// Pure, and kept here rather than in app/log/page.tsx because a Next page
// file may only export the page itself and these are unit-tested.

export interface CellFlag {
  severity: Severity; // the worst among the flags on this cell
  titles: string[]; // what those flags are called, without repeats
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

// What the Log table marks. Keys are "<entry id>|<parameter>" for a flag on
// one reading and "<entry id>|*" for a flag on the whole entry (a rule that
// names no parameter: a duplicate, a row repeated unchanged).
export function flagMarks(flags: Flag[]): { marks: Map<string, CellFlag>; flaggedIds: Set<string> } {
  const marks = new Map<string, CellFlag>();
  const flaggedIds = new Set<string>();
  for (const f of Array.isArray(flags) ? flags : []) {
    if (!f || typeof f !== "object" || !Array.isArray(f.entryIds)) continue;
    // An unknown severity is drawn as the mildest one rather than not at all.
    const severity: Severity = f.severity === "high" || f.severity === "medium" ? f.severity : "low";
    const title = text(f.title).trim();
    const where = KNOWN_PARAMS.has(f.param as string) ? (f.param as string) : "*";
    for (const id of f.entryIds) {
      if (typeof id !== "string" || !id) continue;
      flaggedIds.add(id);
      const key = `${id}|${where}`;
      const cur = marks.get(key);
      if (!cur) {
        marks.set(key, { severity, titles: title ? [title] : [] });
        continue;
      }
      if (SEV_RANK[severity] > SEV_RANK[cur.severity]) cur.severity = severity;
      if (title && !cur.titles.includes(title)) cur.titles.push(title);
    }
  }
  return { marks, flaggedIds };
}

// The flags a /log?entry=<id>&entry=<id>... link was made from, so the Log
// can say which flag it is showing. `flagId` is the link's own flag=<id>,
// when it has one; otherwise a flag is recognised by its link carrying
// exactly these entries. Empty for a link no current flag would make.
export function flagsBehind(flags: Flag[], picked: string[], flagId: string | null | undefined): Flag[] {
  const all = (Array.isArray(flags) ? flags : []).filter((f) => f && typeof f === "object" && Array.isArray(f.entryIds));
  if (flagId) {
    const named = all.filter((f) => f.id === flagId);
    if (named.length > 0) return named;
  }
  const ids = (Array.isArray(picked) ? picked : []).filter((id) => typeof id === "string" && id);
  if (ids.length === 0) return [];
  const want = JSON.stringify([...new Set(ids)].sort());
  return all.filter((f) => {
    const link = logLink(f.entryIds);
    if (!link) return false;
    const carried = new URLSearchParams(link.href.slice(link.href.indexOf("?") + 1)).getAll("entry");
    return JSON.stringify([...new Set(carried)].sort()) === want;
  });
}

// ------------------------------------------------------------------ component

const ZOOM_STEPS = [styles.zoom0, styles.zoom1, styles.zoom2];

export interface EntryDialogProps {
  plant: Plant;
  // null = add an entry by hand.
  entry: LogEntry | null;
  // True when the entry being edited is no longer in the log (deleted or
  // replaced from another tab while this dialog was open). The dialog keeps
  // what was typed and offers to put the entry back.
  gone?: boolean;
  // Everything in the log, for the same-date-and-shift check.
  entries: LogEntry[];
  pages: LogPage[];
  flags: Flag[];
  // Parameters this plant's log already uses; they get a box in the form.
  params: ParamKey[];
  // Open straight on the delete question (the row's delete button).
  askDelete?: boolean;
  getPageImage: (pageId: string) => Promise<string | null>;
  onSave: (entry: LogEntry, isNew: boolean) => void;
  onDelete: (entry: LogEntry) => void;
  onClose: () => void;
}

export function EntryDialog({
  plant, entry: latest, gone = false, entries, pages, flags, params, askDelete = false, getPageImage, onSave, onDelete, onClose,
}: EntryDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const problemsRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const pressedBackdrop = useRef(false);
  // Set once this dialog has reported that it is closing (closed, saved or
  // deleted). The element's own "close" event arrives a moment later and must
  // not report the close a second time: the Log screen would then announce
  // something about an entry that has already been dealt with.
  const leaving = useRef(false);
  const base = useId();

  // The entry as last seen in the log. It follows the log while the entry is
  // there, and holds the last version once the entry is gone.
  const [entry, setEntry] = useState(latest);
  // What the form showed when it opened (or when it last took in a save made
  // elsewhere). "Unsaved changes" means: different from this.
  const [initial, setInitial] = useState(() => draftFrom(latest, localToday()));
  const [draft, setDraft] = useState<Draft>(initial);
  const [extra, setExtra] = useState<ParamKey[]>([]);
  // Set once the entry has been saved from somewhere else while open here.
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [confirm, setConfirm] = useState<null | "delete" | "discard">(askDelete && latest ? "delete" : null);
  // Counts presses of Save that were refused, so each one moves focus to the reasons.
  const [refused, setRefused] = useState(0);
  // undefined = still loading, null = not on this device.
  const [image, setImage] = useState<string | null | undefined>(undefined);
  const [zoom, setZoom] = useState(0);

  if (latest && !gone && latest !== entry) {
    // The log now holds a different version of this entry (it was saved from
    // another tab). Take it in during this render, so the form never shows or
    // saves a stale value: boxes the person has not touched show the saved
    // values, and what they typed is kept.
    setEntry(latest);
    const saved = draftFrom(latest, "");
    if (!sameDraft(saved, initial)) {
      // A box must not vanish from an open form because its value was cleared elsewhere.
      setExtra((x) => [...x, ...PARAM_KEYS.filter((k) => initial.cells[k] !== undefined && !x.includes(k))]);
      setDraft(rebaseDraft(draft, initial, saved));
      setInitial(saved);
      setChangedElsewhere(true);
    }
  }

  const shiftsPerDay = plant.shiftsPerDay === 1 || plant.shiftsPerDay === 2 ? plant.shiftsPerDay : 3;
  const meta = useMemo(() => metaOf(entry), [entry]);
  const before = useMemo(() => new Set(editedBefore(entry)), [entry]);
  const pageId = typeof entry?.pageId === "string" && entry.pageId ? entry.pageId : null;
  const fromSample = pageId === "seed";
  const page = pageId && !fromSample ? pages.find((p) => p && p.id === pageId) ?? null : null;
  const hasPhoto = pageId !== null && !fromSample;
  // A bundled sample page is generated data even when the live reader read it;
  // the capture screen records that in the page's "model".
  const samplePage = page !== null && /\bsample\b/i.test(text(page.model));
  const uploadedAt = page ? text(page.uploadedAt) : "";

  // Every parameter the plant uses, plus whatever this entry itself carries.
  // What the register actually records comes first; parameters that only
  // have a consent limit (not yet in any entry) follow.
  const keys = useMemo(() => {
    const used = (k: ParamKey) =>
      params.includes(k) || extra.includes(k) || initial.cells[k] !== undefined || meta[k] !== undefined || before.has(k);
    return [...COLUMN_ORDER.filter(used), ...COLUMN_ORDER.filter((k) => !used(k) && Boolean(plant.limits?.[k]))];
  }, [params, extra, initial, meta, before, plant.limits]);
  const spare = COLUMN_ORDER.filter((k) => !keys.includes(k));

  // An entry that is gone from the log holds no place in it any more, so
  // putting it back is checked the way a new entry is: it may not take a date
  // and shift that something else now fills.
  const check = useMemo(
    () => checkDraft(draft, gone ? null : entry, entries, shiftsPerDay, keys, localToday()),
    [draft, gone, entry, entries, shiftsPerDay, keys],
  );
  const dirty = !sameDraft(draft, initial);
  const myFlags = useMemo(
    () => (entry && !gone ? flags.filter((f) => Array.isArray(f?.entryIds) && f.entryIds.includes(entry.id)) : []),
    [flags, entry, gone],
  );

  // A one-row-a-day register has no shift letters; offer the boxes only when
  // the plant runs shifts or this entry already carries one.
  const showShift = shiftsPerDay > 1 || initial.shift !== "" || draft.shift !== "";
  const showTime = shiftsPerDay > 1 || initial.time !== "" || draft.time !== "";
  const storedDate = entry ? text(entry.date) : "";
  const hadBadDate = Boolean(entry) && !isIsoDate(storedDate);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", ""); // very old browser: still usable, not modal
      }
    }
    // An existing entry opens on its title (no keyboard popping up on a phone);
    // a new one opens ready to type.
    if (confirmRef.current) confirmRef.current.focus();
    else if (entry) titleRef.current?.focus();
    else dateRef.current?.focus();
    // Only on mount: the dialog is remounted for each entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (confirm) confirmRef.current?.focus();
  }, [confirm]);

  useEffect(() => {
    if (refused > 0) problemsRef.current?.focus();
  }, [refused]);

  useEffect(() => {
    if (!hasPhoto || !pageId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A photo saved a moment ago may not be readable yet (a browser can start
    // a read before an earlier write has landed), so a miss is asked again
    // before the dialog says the photo is not here.
    const justSaved = Date.now() - Date.parse(uploadedAt) < 120000;
    const waits = justSaved ? [500, 2000] : [500];
    const load = (attempt: number) => {
      Promise.resolve()
        .then(() => getPageImage(pageId))
        .catch(() => null)
        .then((v) => {
          if (!alive) return;
          if (typeof v === "string" && v.startsWith("data:image/")) setImage(v);
          else if (attempt < waits.length) timer = setTimeout(() => load(attempt + 1), waits[attempt]);
          else setImage(null);
        });
    };
    load(0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [hasPhoto, pageId, uploadedAt, getPageImage]);

  // Closing through the element first lets the browser hand focus back to the
  // row or button that opened the dialog.
  function shut() {
    const d = ref.current;
    if (d?.open) {
      try {
        d.close();
      } catch {
        /* already closed */
      }
    }
  }

  function leave(report: () => void) {
    leaving.current = true;
    shut();
    report();
  }

  function requestClose() {
    if (dirty && confirm !== "discard") {
      setConfirm("discard");
      return;
    }
    leave(onClose);
  }

  // The entry was deleted somewhere else and nothing typed here would be lost:
  // the dialog gets out of the way, and the Log screen says what happened.
  useEffect(() => {
    if (!gone || dirty) return;
    leave(onClose);
    // Only at the moment the entry disappears. A form that holds typed text
    // stays open, even if that text is later put back to what it was.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone]);

  function save() {
    if (check.errors.length > 0) {
      setRefused((n) => n + 1);
      setConfirm(null);
      return;
    }
    const built = buildEntry(draft, entry, plant.id, keys, new Date().toISOString(), uid("e"), initial);
    // An entry that is gone from the log has to be added again, not updated.
    leave(() => onSave(built.entry, entry === null || gone));
  }

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  const title = entry ? `Entry for ${entryLabel(entry)}` : "Add an entry by hand";
  // "Enter a reading" is not worth saying while a new entry is still being typed.
  const shownErrors = refused > 0 || entry ? check.errors : check.errors.filter((m) => m !== EMPTY_ENTRY_MESSAGE);
  // An empty add-by-hand form should not open on a warning. For a new entry
  // the advice to pick a shift sits under the Shift box instead; an existing
  // entry only gets the warning when its shift has just been taken away.
  const shownWarnings = entry ? check.warnings : check.warnings.filter((m) => m !== NO_SLOT_MESSAGE);
  const shiftHint = !entry && shiftsPerDay > 1 && !draft.shift && !draft.time.trim();
  // There is nothing left to delete once the entry is gone from the log.
  const confirmingDelete = confirm === "delete" && !gone;
  const lowCells = keys.filter((k) => meta[k]?.confidence === "low");
  const metaKeys = COLUMN_ORDER.filter((k) => meta[k] !== undefined);

  return (
    <dialog
      ref={ref}
      className={`${styles.dlg} ${hasPhoto ? "" : styles.narrow}`}
      aria-labelledby={`${base}-title`}
      onCancel={(e) => {
        // Esc. With unsaved changes the first press asks; a second one discards.
        if (confirm === "discard") return;
        if (confirm === "delete") {
          e.preventDefault();
          setConfirm(null);
        } else if (dirty) {
          e.preventDefault();
          setConfirm("discard");
        }
      }}
      onClose={() => {
        // Fired after the browser closed the dialog itself (Esc).
        if (!ref.current?.open && !leaving.current) {
          leaving.current = true;
          onClose();
        }
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // A click that both started and ended on the backdrop, not a text
        // selection dragged out of the form.
        if (e.target === e.currentTarget && pressedBackdrop.current) requestClose();
      }}
    >
      <form
        className={styles.shell}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <header className={styles.head}>
          <div>
            <h2 id={`${base}-title`} ref={titleRef} tabIndex={-1} className={styles.title}>{title}</h2>
            <p className="muted small">
              {entry
                ? "Correct anything that does not match the paper. Changed readings are recorded as changed by a person."
                : "For a shift or day that was never photographed. It is saved as typed in by hand."}
            </p>
          </div>
          <button type="button" className="btn sm" onClick={requestClose} aria-label="Close"><Cross /></button>
        </header>

        <div className={styles.body}>
          {hadBadDate && (
            <div className="notice warn">
              This entry was stored with a date that is not a real calendar date
              {storedDate ? ` (“${clip(storedDate, 30)}”)` : ""}. Choose the right date and save.
            </div>
          )}
          <div ref={problemsRef} tabIndex={-1} className={styles.problems} role="alert">
            {shownErrors.length > 0 && (
              <div className="notice bad">
                {shownErrors.length === 1 ? shownErrors[0] : <ul className={styles.list}>{shownErrors.map((m) => <li key={m}>{m}</li>)}</ul>}
              </div>
            )}
          </div>
          <div className={styles.problems} role="status">
            {gone ? (
              <div className="notice warn">
                This entry is no longer in the log: it was deleted or replaced in another tab or window while it was open here.
                What you typed is still in this form. “Put entry back” saves it to the log again with your changes; closing leaves it out.
              </div>
            ) : changedElsewhere ? (
              <div className="notice warn">
                This entry was saved from another tab or window while it was open here. Boxes you had not touched now show the saved values
                {dirty ? "; what you typed is kept, and each changed box says what is saved." : "."}
              </div>
            ) : null}
          </div>
          {shownWarnings.map((m) => <div className="notice warn" key={m}>{m}</div>)}

          <div className={hasPhoto ? styles.cols : undefined}>
            {hasPhoto && (
              <section className={styles.photoCol} aria-label="Source photo">
                {image === undefined && <p className={`${styles.noPhoto} muted small`} role="status">Loading the photo…</p>}
                {image === null && (
                  <p className={`${styles.noPhoto} small`}>
                    Photo not available on this device. Page photos are kept only in the browser that captured them.
                  </p>
                )}
                {typeof image === "string" && (
                  <>
                    <div className={`${styles.photo} ${ZOOM_STEPS[zoom]}`} tabIndex={0} role="group" aria-label="Photographed logbook page (scrolls when zoomed)">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={image} alt={`Photographed logbook page${page?.fileName ? ` ${clip(text(page.fileName), 60)}` : ""}`}
                        onClick={() => setZoom((z) => (z + 1) % ZOOM_STEPS.length)}
                      />
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button type="button" className="btn sm" disabled={zoom >= ZOOM_STEPS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOM_STEPS.length - 1, z + 1))}>Zoom in</button>
                      <button type="button" className="btn sm" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>Zoom out</button>
                      <span className="muted small">Drag or scroll to move around the page.</span>
                    </div>
                  </>
                )}
              </section>
            )}

            <div className={styles.formCol}>
              <div className={styles.fields}>
                <label className="field">
                  Date
                  <input
                    ref={dateRef} type="date" required value={draft.date}
                    aria-invalid={!isIsoDate(draft.date)} onChange={(e) => patch({ date: e.target.value })}
                  />
                </label>
                {showShift && (
                  <label className="field">
                    Shift
                    <select value={draft.shift} onChange={(e) => patch({ shift: e.target.value as ShiftCode | "" })}>
                      <option value="">–</option>
                      {SHIFT_CODES.map((s) => <option key={s}>{s}</option>)}
                    </select>
                    {shiftHint && <span className="hint">Pick the shift, or give the time, so this entry fills its place in the register.</span>}
                  </label>
                )}
                {showTime && (
                  <label className="field">
                    Time (24-hour, optional)
                    <input
                      value={draft.time} placeholder="HH:MM" maxLength={5} autoComplete="off"
                      aria-invalid={Boolean(draft.time) && !TIME_RE.test(draft.time)}
                      onChange={(e) => patch({ time: e.target.value.trim() })}
                    />
                  </label>
                )}
                <label className="field">
                  Operator
                  <input value={draft.operator} maxLength={60} onChange={(e) => patch({ operator: e.target.value })} />
                </label>
              </div>

              <h3 className={styles.sub}>Readings</h3>
              {keys.length === 0 && <p className="muted small">No parameters yet. Add the ones this register records.</p>}
              <div className={styles.params}>
                {keys.map((k) => {
                  const p = PARAMS[k];
                  const raw = draft.cells[k] ?? "";
                  const v = parseCell(raw);
                  const was = cleanNumber(entry?.values?.[k]);
                  const changedNow = entry !== null && v !== undefined && !sameValue(was, v);
                  const changedEarlier = before.has(k);
                  const unsure = meta[k]?.confidence === "low" && !changedNow && !changedEarlier;
                  const impossible = typeof v === "number" && outsidePhysical(k, v);
                  const state =
                    v === undefined || impossible ? styles.invalid
                    : changedNow || changedEarlier ? styles.edited
                    : unsure ? styles.low : "";
                  const onPage = meta[k] ? `page says “${clip(text(meta[k]?.raw), 24)}”` : null;
                  const hint =
                    v === undefined ? "Not a number"
                    : impossible ? `Cannot be a real reading (${p.physicalMin} to ${p.physicalMax})`
                    : changedNow ? [`was ${was === null ? "blank" : cellText(k, was)}`, onPage].filter(Boolean).join(" · ")
                    : changedEarlier ? ["changed by a person", onPage].filter(Boolean).join(" · ")
                    : unsure ? ["reader unsure", onPage].filter(Boolean).join(" · ")
                    : onPage ?? limitText(k, plant.limits?.[k]) ?? "";
                  return (
                    <label key={k} className={styles.param}>
                      <span>{p.label}{p.unit ? <small> {p.unit}</small> : null}</span>
                      <input
                        className={state} inputMode="decimal" maxLength={24} value={raw} autoComplete="off"
                        aria-invalid={v === undefined} aria-describedby={`${base}-${k}`}
                        onChange={(e) => patch({ cells: { ...draft.cells, [k]: e.target.value } })}
                      />
                      <small id={`${base}-${k}`} className={styles.hint}>{hint || " "}</small>
                    </label>
                  );
                })}
              </div>
              {spare.length > 0 && (
                <select
                  className={styles.addParam} value="" aria-label="Add a parameter to this entry"
                  onChange={(e) => {
                    const k = e.target.value as ParamKey;
                    if (KNOWN_PARAMS.has(k)) setExtra((x) => [...x, k]);
                  }}
                >
                  <option value="">Add a parameter…</option>
                  {spare.map((k) => <option key={k} value={k}>{PARAMS[k].label}</option>)}
                </select>
              )}
              <p className="muted small" style={{ marginTop: 8 }}>
                Yellow = the reader was unsure · blue = changed by a person · red = not a number, or a value that cannot be a real reading.
              </p>

              <label className={`field ${styles.remarks}`}>
                Remarks
                <textarea value={draft.remarks} maxLength={300} rows={2} onChange={(e) => patch({ remarks: e.target.value })} />
              </label>
            </div>
          </div>

          {entry && (
            <section className={styles.section} aria-labelledby={`${base}-prov`}>
              <h3 id={`${base}-prov`}>Where this entry came from</h3>
              <dl className={styles.facts}>
                <dt>Source</dt>
                <dd>
                  {fromSample ? "Generated sample history. Not a real register, and there is no photo."
                    : !pageId ? "Typed in by hand. No photo."
                    : page && samplePage ? `Generated sample page (${clip(text(page.fileName) || "unnamed file", 80)}). Not a real plant's register.`
                    : page ? `Photographed page: ${clip(text(page.fileName) || "unnamed file", 80)}`
                    : "A photographed page whose record is not on this device."}
                </dd>
                {page && (
                  <>
                    <dt>Read by</dt>
                    <dd>{clip(text(page.model) || "not recorded", 80)}</dd>
                  </>
                )}
                <dt>Digitised</dt>
                <dd>{formatWhen(entry.capturedAt)}</dd>
                {hasPhoto && (
                  <>
                    <dt>Reader unsure of</dt>
                    <dd>{lowCells.length ? lowCells.map((k) => PARAMS[k].label).join(", ") : "None"}</dd>
                  </>
                )}
                <dt>Changed by a person</dt>
                <dd>{before.size ? [...before].map((k) => PARAMS[k].label).join(", ") : "None"}</dd>
              </dl>
              {page && Array.isArray(page.notes) && page.notes.length > 0 && (
                <ul className={`${styles.list} muted small`}>
                  {page.notes.slice(0, 8).map((n, i) => {
                    // Notes the model wrote carry this prefix; the rest are warnings
                    // JalLog added while reading the answer (dates, units).
                    const t = text(n);
                    const own = t.startsWith(READER_NOTE_PREFIX);
                    return <li key={i}>{own ? "Reader's note on the page: " : "Note from reading the page: "}{clip(own ? t.slice(READER_NOTE_PREFIX.length) : t, 300)}</li>;
                  })}
                </ul>
              )}
              {metaKeys.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th className="l">Parameter</th>
                        <th className="l">Written on the page</th>
                        <th>Saved value</th>
                        <th className="l">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metaKeys.map((k) => (
                        <tr key={k}>
                          <td className="l">{PARAMS[k].label}</td>
                          <td className="l wrap">{clip(text(meta[k]?.raw), 60) || <span className="muted">blank</span>}</td>
                          <td>{cellText(k, entry.values?.[k]) || "–"}</td>
                          <td className="l">
                            {[meta[k]?.confidence === "low" ? "reader unsure" : "", before.has(k) ? "changed by a person" : ""].filter(Boolean).join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {entry && !gone && (
            <section
              className={styles.section} aria-labelledby={`${base}-flags`}
              // A flag's "show in the log" link leads to the table behind this
              // dialog. Unsaved changes are asked about first; otherwise the
              // dialog gets out of the way and the link goes ahead.
              onClickCapture={(e) => {
                const target = e.target as Element | null;
                if (!target?.closest?.('a[href^="/log"]')) return;
                if (dirty) {
                  e.preventDefault();
                  setConfirm("discard");
                } else {
                  leave(onClose);
                }
              }}
            >
              <h3 id={`${base}-flags`}>Flags that include this entry ({myFlags.length})</h3>
              {myFlags.length === 0 ? (
                <p className="muted small">No rule has raised this entry.</p>
              ) : (
                <>
                  <p className="muted small" style={{ marginBottom: 10 }}>Each is a reason to check, not a finding against anyone. Flags are worked out again after every save.</p>
                  <FlagList flags={myFlags} />
                </>
              )}
            </section>
          )}
        </div>

        <footer className={styles.foot}>
          {confirmingDelete && entry ? (
            <div className={styles.confirm} role="group" aria-label="Confirm delete">
              <span>Delete the entry for {entryLabel(entry)}? {dirty ? "Your unsaved changes go with it. " : ""}You can undo this straight afterwards.</span>
              <span className="row">
                <button type="button" className="btn" onClick={() => setConfirm(null)}>Keep it</button>
                <button
                  type="button" ref={confirmRef} className={`btn ${styles.dangerBtn}`}
                  onClick={() => leave(() => onDelete(entry))}
                >
                  Delete entry
                </button>
              </span>
            </div>
          ) : confirm === "discard" ? (
            <div className={styles.confirm} role="group" aria-label="Unsaved changes">
              <span>Your changes to this entry are not saved.</span>
              <span className="row">
                <button type="button" className="btn danger" onClick={() => leave(onClose)}>Discard changes</button>
                <button type="button" ref={confirmRef} className="btn primary" onClick={() => setConfirm(null)}>Keep editing</button>
              </span>
            </div>
          ) : (
            <>
              {/* On a narrow phone the second word of each label is hidden so the
                  three buttons stay on one row; the full name stays as the label. */}
              {entry && !gone && (
                <button type="button" className="btn danger" aria-label="Delete entry" onClick={() => setConfirm("delete")}>
                  <span>Delete<span className={styles.wide}> entry</span></span>
                </button>
              )}
              <span className="spacer" />
              <button type="button" className="btn" onClick={requestClose}>{dirty ? "Cancel" : "Close"}</button>
              {gone ? (
                <button type="submit" className="btn primary">Put entry back</button>
              ) : entry ? (
                <button type="submit" className="btn primary" aria-label="Save changes" disabled={!dirty}>
                  <span>Save<span className={styles.wide}> changes</span></span>
                </button>
              ) : (
                <button type="submit" className="btn primary">Add entry</button>
              )}
            </>
          )}
        </footer>
      </form>
    </dialog>
  );
}
