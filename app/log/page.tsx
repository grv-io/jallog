"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { EntryDialog, cleanNumber, entryLabel, entrySlot, flagMarks, flagsBehind, text } from "@/components/EntryDialog";
import type { CellFlag } from "@/components/EntryDialog";
import styles from "@/components/EntryDialog.module.css";
import { Cross } from "@/components/TopBar";
import { COLUMN_ORDER, PARAMS, fmt } from "@/lib/params";
import { formatDate, localToday, useStore } from "@/lib/store";
import type { LogEntry, LogPage, ParamKey, Severity } from "@/lib/types";
import { UTF8_BOM, byRegisterOrder, cmp, csvFileName, dateOf, toCsv } from "./csv";

// Rows drawn at a time. A year of three-shift entries is over a thousand rows;
// drawing them all at once makes every click wait.
const PAGE_SIZE = 200;
const UNDATED = "undated";
// A flag links here as /log?entry=<id>&entry=<id>... (see logLink in FlagList).
const MAX_PICKED = 200;

function show(k: ParamKey, v: unknown): string {
  const n = cleanNumber(v);
  return n === null ? "–" : fmt(k, n);
}

// Meter columns say so in their heading. "kWh" over "kWh" reads as energy
// used in the shift, when the number under it is the meter's running total.
function columnHead(k: ParamKey): string {
  const short = PARAMS[k].short;
  return PARAMS[k].kind === "cumulative" && !/met(er|re)|mtr/i.test(short) ? `${short} meter` : short;
}

const SEV_WORD: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

// "High flag on the whole entry: Duplicate entries". Shown as the cell's
// tooltip and read out by a screen reader, so the mark is never colour alone.
function describeMark(m: CellFlag, wholeEntry: boolean): string {
  const names = m.titles.slice(0, 3).join("; ");
  const more = m.titles.length > 3 ? `; and ${m.titles.length - 3} more` : "";
  return `${SEV_WORD[m.severity]} flag${wholeEntry ? " on the whole entry" : ""}${names ? `: ${names}${more}` : ""}`;
}

// The same three shapes as the severity badges on the Flags screen, so a
// flagged cell can be told apart without relying on its tint.
function Mark({ sev }: { sev: Severity }) {
  return (
    <svg
      className={`${styles.mark} ${sev === "high" ? styles.markHigh : sev === "medium" ? styles.markMedium : styles.markLow}`}
      width="9" height="9" viewBox="0 0 12 12" aria-hidden
    >
      {sev === "high" ? (
        <path d="M6 1l5.2 9.5H.8z" fill="currentColor" />
      ) : sev === "medium" ? (
        <rect x="2" y="2" width="8" height="8" rx="1.5" transform="rotate(45 6 6)" fill="currentColor" />
      ) : (
        <circle cx="6" cy="6" r="3.6" fill="currentColor" />
      )}
    </svg>
  );
}

// `opened` is the entry as it was when its dialog was opened. It is what the
// dialog falls back on if the entry is deleted from another tab meanwhile.
type View = { kind: "edit"; id: string; askDelete: boolean; opened: LogEntry } | { kind: "new" } | null;

// What is needed to take a delete back. The store drops a page record and its
// photo once the last entry read from that page is gone, so both are picked
// up before the delete is issued.
interface Undo {
  entry: LogEntry;
  page: LogPage | null;
  photo: Promise<string | null> | null;
  // Other entries that held the same date and shift when this one was deleted.
  siblings: string[];
}

// useSearchParams needs a Suspense boundary above it for the page to build.
export default function LogPageView() {
  return (
    <Suspense fallback={null}>
      <LogScreen />
    </Suspense>
  );
}

function LogScreen() {
  const store = useStore();
  const router = useRouter();
  const search = useSearchParams();
  // The entries a flag pointed at, as a stable string so the memo below holds.
  const pickedKey = JSON.stringify((search?.getAll("entry") ?? []).filter(Boolean).slice(0, MAX_PICKED));
  const pickedList = useMemo(() => JSON.parse(pickedKey) as string[], [pickedKey]);
  const picked = useMemo(() => new Set<string>(pickedList), [pickedList]);
  // Optional: a link may also say which flag it came from (/log?flag=<id>&entry=...).
  const flagParam = (search?.get("flag") ?? "").slice(0, 200);
  const { ready, plant, checks, addPage, addEntry, updateEntry, deleteEntry, getPageImage } = store;
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [month, setMonth] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [view, setView] = useState<View>(null);
  // The last deleted entry, kept so the delete can be taken back.
  const [undo, setUndo] = useState<Undo | null>(null);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const restoring = useRef(false);

  // Saved data is read defensively: anything that is not an entry with an id
  // cannot be listed or opened.
  const all = useMemo(() => (Array.isArray(store.entries) ? store.entries : []), [store.entries]);
  const entries = useMemo(() => all.filter((e) => e && typeof e === "object" && typeof e.id === "string" && e.id), [all]);
  const pages = useMemo(() => (Array.isArray(store.pages) ? store.pages : []), [store.pages]);
  const flags = useMemo(() => (Array.isArray(checks?.flags) ? checks.flags : []), [checks]);

  const sorted = useMemo(() => [...entries].sort(byRegisterOrder).reverse(), [entries]);
  const columns = useMemo(
    () => COLUMN_ORDER.filter((k) => entries.some((e) => cleanNumber(e.values?.[k]) !== null)),
    [entries],
  );

  // Worst severity and the flag names per entry + parameter, so a cell can be marked.
  const { marks, flaggedIds } = useMemo(() => flagMarks(flags), [flags]);
  // The flag (or flags) a "show in the log" link was made from, to name it.
  const behind = useMemo(() => flagsBehind(flags, pickedList, flagParam), [flags, pickedList, flagParam]);

  // Months that have entries, newest first, for the month filter.
  const months = useMemo(() => {
    const count = new Map<string, number>();
    for (const e of entries) {
      const m = dateOf(e).slice(0, 7) || UNDATED;
      count.set(m, (count.get(m) ?? 0) + 1);
    }
    return [...count.entries()].sort((a, b) => (a[0] === UNDATED ? -1 : b[0] === UNDATED ? 1 : cmp(b[0], a[0])));
  }, [entries]);
  // A month whose last entry was just deleted must not leave the table empty.
  const activeMonth = months.some(([m]) => m === month) ? month : "";

  const rows = useMemo(
    () =>
      picked.size > 0
        ? sorted.filter((e) => picked.has(e.id))
        : sorted.filter(
            (e) => (!flaggedOnly || flaggedIds.has(e.id)) && (!activeMonth || (dateOf(e).slice(0, 7) || UNDATED) === activeMonth),
          ),
    [sorted, picked, flaggedOnly, flaggedIds, activeMonth],
  );

  useEffect(() => {
    if (undo) undoRef.current?.focus();
  }, [undo]);

  if (!ready) return null;

  const current = view?.kind === "edit" ? entries.find((e) => e.id === view.id) ?? null : null;
  // The entry whose dialog is open has left the log (deleted or replaced from another tab).
  const openGone = view?.kind === "edit" && !current;
  const flaggedCount = entries.reduce((n, e) => n + (flaggedIds.has(e.id) ? 1 : 0), 0);
  const unlisted = all.length - entries.length;
  const hasSlot = entries.some((e) => text(e.shift) || text(e.time));
  const slotHead = entries.some((e) => text(e.shift)) ? "Shift" : "Time";
  const visible = rows.slice(0, limit);

  function download() {
    try {
      // The BOM tells Excel the file is UTF-8, so m³ and names in Hindi survive.
      const blob = new Blob([UTF8_BOM + toCsv(all.filter((e) => e && typeof e === "object"), pages)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFileName(plant?.name, localToday());
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking at once cancels the download in some browsers.
      window.setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {
      setNote({ bad: true, text: "The CSV file could not be created in this browser." });
    }
  }

  function closeDialog() {
    if (view?.kind === "edit" && !current) {
      // Said here because the dialog that would have said it is closing.
      setNote({
        bad: true,
        text: `The entry for ${entryLabel(view.opened)} is no longer in the log: it was deleted or replaced in another tab or window.`,
      });
    }
    setView(null);
  }

  function saveEntry(entry: LogEntry, isNew: boolean) {
    const perDay = plant?.shiftsPerDay ?? 3;
    try {
      if (!isNew && !entries.some((e) => e.id === entry.id)) {
        // An update to an entry that is not there would change nothing and
        // still look saved. The dialog asks for an add in that case; this is
        // the same answer for a save that slipped through.
        const slot = entrySlot(entry, perDay);
        if (slot !== null && entries.some((e) => entrySlot(e, perDay) === slot)) {
          setNote({
            bad: true,
            text: `The entry for ${entryLabel(entry)} was not saved: it is no longer in the log, and another entry now holds its place. Open that entry to correct it.`,
          });
          setView(null);
          return;
        }
        addEntry(entry);
      } else if (isNew) addEntry(entry);
      else updateEntry(entry);
      setNote({ bad: false, text: `${isNew ? "Added" : "Saved"} the entry for ${entryLabel(entry)}. The checks have been run again.` });
    } catch {
      setNote({ bad: true, text: "The entry could not be saved. Nothing was changed." });
    }
    setView(null);
  }

  function removeEntry(entry: LogEntry) {
    if (!entries.some((e) => e.id === entry.id)) {
      // Already gone (deleted from another tab): nothing to delete, nothing to undo.
      setView(null);
      return;
    }
    const pid = text(entry.pageId);
    const page = pid ? pages.find((p) => p && p.id === pid) ?? null : null;
    let photo: Undo["photo"] = null;
    if (page) {
      try {
        // Asked for before the delete below, so the read is ahead of the clean-up.
        photo = getPageImage(pid).catch(() => null);
      } catch {
        photo = null;
      }
    }
    const perDay = plant?.shiftsPerDay ?? 3;
    const slot = entrySlot(entry, perDay);
    const siblings = slot === null ? [] : entries.filter((e) => e.id !== entry.id && entrySlot(e, perDay) === slot).map((e) => e.id);
    deleteEntry(entry.id);
    setUndo({ entry, page, photo, siblings });
    setNote(null);
    setView(null);
  }

  async function restore() {
    if (!undo || !plant || restoring.current) return;
    const { entry, page, photo, siblings } = undo;
    if (entries.some((e) => e.id === entry.id)) {
      setUndo(null);
      return;
    }
    // The store replaces an entry that holds the same date and shift, so
    // putting this one back must not push out one added in the meantime.
    const slot = entrySlot(entry, plant.shiftsPerDay);
    const sharing = slot === null ? [] : entries.filter((e) => entrySlot(e, plant.shiftsPerDay) === slot);
    if (sharing.some((e) => !siblings.includes(e.id))) {
      setNote({
        bad: true,
        text: `The entry for ${entryLabel(entry)} was not restored: the log now has another entry for the same date${plant.shiftsPerDay === 1 ? "" : " and shift"}. Delete or re-date that one, then press Undo again.`,
      });
      return;
    }
    // Entries that shared the date and shift before the delete are a different
    // matter: undo must leave the log as it was, with all of them. The store
    // has no "add without replacing", so the entry goes in without its date
    // (an undated entry replaces nothing) and gets its own fields back in the
    // very next change. Both changes are made before the screen is redrawn.
    const apart = sharing.length > 0;
    const first = apart ? { ...entry, date: "" } : entry;
    restoring.current = true;
    try {
      if (page && !pages.some((p) => p && p.id === page.id)) {
        // The page went with its last entry: put the record and the photo back too.
        const image = photo ? await photo : null;
        addPage({ ...page, imageDataUrl: image ?? "" }, [first]);
      } else {
        addEntry(first);
      }
      if (apart) updateEntry(entry);
      setNote({ bad: false, text: `Restored the entry for ${entryLabel(entry)}.` });
      setUndo(null);
    } catch {
      setNote({ bad: true, text: "The entry could not be restored. Press Undo to try again." });
    } finally {
      restoring.current = false;
    }
  }

  // "Showing only the 9 entries of the flag ..." for a link from a flag.
  function pickedNotice(): string {
    const n = rows.length;
    if (n === 0) return "The entries this link points to are no longer in the log.";
    const what = n === 1 ? "the entry" : `the ${n} entries`;
    const names = [...new Set(behind.map((f) => text(f.title).trim().slice(0, 120)).filter(Boolean))];
    if (names.length === 0) return `Showing only ${what} this link points to.`;
    if (names.length === 1) {
      const total = behind.length === 1 ? new Set(behind[0].entryIds.filter((id) => typeof id === "string" && id)).size : 0;
      const part = total > picked.size ? ` The flag covers ${total} entries; this link carries the first ${picked.size}.` : "";
      return `Showing only ${what} of the flag “${names[0]}”.${part}`;
    }
    const more = names.length > 3 ? `; and ${names.length - 3} more` : "";
    return `Showing only ${what} that these flags point to: ${names.slice(0, 3).map((t) => `“${t}”`).join("; ")}${more}.`;
  }

  const dialog =
    view && plant ? (
      <EntryDialog
        key={view.kind === "new" ? "new" : view.id}
        plant={plant}
        entry={view.kind === "new" ? null : current ?? view.opened}
        gone={openGone}
        entries={entries}
        pages={pages}
        flags={flags}
        params={columns}
        askDelete={view.kind === "edit" && view.askDelete}
        getPageImage={getPageImage}
        onSave={saveEntry}
        onDelete={removeEntry}
        onClose={closeDialog}
      />
    ) : null;

  const notices = (
    <>
      {undo && (
        <div className={`notice ${styles.undo}`} role="status">
          <span>Deleted the entry for {entryLabel(undo.entry)}. It can be put back until you leave this screen or delete another.</span>
          <span className="row">
            <button ref={undoRef} className="btn sm" onClick={restore}>Undo</button>
            <button className="btn sm" onClick={() => setUndo(null)} aria-label="Dismiss the undo offer">Dismiss</button>
          </span>
        </div>
      )}
      {note && <div className={`notice ${note.bad ? "bad" : ""}`} role={note.bad ? "alert" : "status"}>{note.text}</div>}
      {unlisted > 0 && (
        <div className="notice warn">
          {unlisted} stored {unlisted === 1 ? "record is" : "records are"} damaged (no identifier) and cannot be listed here. {unlisted === 1 ? "It is" : "They are"} still included in the CSV download.
        </div>
      )}
    </>
  );

  if (!plant) {
    return (
      <div className={`card ${styles.empty}`}>
        <h2>Choose a plant first</h2>
        <p>The log belongs to a plant. Set one up, or open a sample plant from the Overview.</p>
        <div className="row">
          <Link className="btn primary" href="/plant">Set up my plant</Link>
          <Link className="btn" href="/">Open a sample plant</Link>
          {all.length > 0 && <button className="btn" onClick={download}>Download CSV of stored entries</button>}
        </div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="stack">
        {notices}
        <div className={`card ${styles.empty}`}>
          <h2>The log is empty</h2>
          <p>
            Entries appear here after a logbook page is reviewed and saved. A shift or day that was never photographed can be typed in by hand.
          </p>
          <div className="row">
            <Link className="btn primary" href="/capture">Add a logbook page</Link>
            <button className="btn" onClick={() => setView({ kind: "new" })}>Add entry by hand</button>
            {all.length > 0 && <button className="btn" onClick={download}>Download CSV</button>}
          </div>
        </div>
        {dialog}
      </div>
    );
  }

  const seen = new Set<string>();
  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Log</h1>
          <p>
            {entries.length.toLocaleString("en-IN")} {entries.length === 1 ? "entry" : "entries"}, newest first.
            Select a row to open the entry, correct it, and see the page it came from.
          </p>
          <p className="small">
            A marked cell carries a flag: <Mark sev="high" />high, <Mark sev="medium" />medium, <Mark sev="low" />low.
            A bar at the start of a row is a flag on the whole entry. Open the entry to see which flags it is in.
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setView({ kind: "new" })}>Add entry by hand</button>
          <button className="btn" onClick={download}>Download CSV</button>
        </div>
      </div>

      {notices}

      {picked.size > 0 ? (
        <div className={`notice ${styles.undo}`}>
          <span>
            {pickedNotice()}
          </span>
          <button className="btn sm" onClick={() => router.replace("/log")}>Show all entries</button>
        </div>
      ) : (
        <div className={styles.toolbar}>
          <div className="row" role="group" aria-label="Which entries to show">
            <button className={`btn sm ${flaggedOnly ? "" : "primary"}`} aria-pressed={!flaggedOnly} onClick={() => { setFlaggedOnly(false); setLimit(PAGE_SIZE); }}>
              All · {entries.length.toLocaleString("en-IN")}
            </button>
            <button className={`btn sm ${flaggedOnly ? "primary" : ""}`} aria-pressed={flaggedOnly} onClick={() => { setFlaggedOnly(true); setLimit(PAGE_SIZE); }}>
              Flagged only · {flaggedCount.toLocaleString("en-IN")}
            </button>
          </div>
          <label className="row small" style={{ gap: 6 }}>
            Month
            <select value={activeMonth} onChange={(e) => { setMonth(e.target.value); setLimit(PAGE_SIZE); }}>
              <option value="">All months</option>
              {months.map(([m, n]) => (
                <option key={m} value={m}>
                  {m === UNDATED ? "No valid date" : formatDate(`${m}-01`, { month: "long", year: "numeric" })} ({n})
                </option>
              ))}
            </select>
          </label>
          {(flaggedOnly || activeMonth) && (
            <span className="muted small">Showing {rows.length.toLocaleString("en-IN")} of {entries.length.toLocaleString("en-IN")}</span>
          )}
        </div>
      )}

      {rows.length === 0 && picked.size > 0 ? null : rows.length === 0 ? (
        <div className={`card ${styles.empty}`}>
          <h2>No entries match</h2>
          <p>
            {flaggedOnly && flaggedCount === 0
              ? "No entry in the log is included in a flag."
              : "No entry fits both the month and the flagged-only filter."}
          </p>
          <button className="btn" onClick={() => { setFlaggedOnly(false); setMonth(""); setLimit(PAGE_SIZE); }}>Show all entries</button>
        </div>
      ) : (
        <div className={`table-wrap ${styles.tableBox}`}>
          <table className="data">
            <thead>
              <tr>
                <th className="l">Date</th>
                {hasSlot && <th className="l">{slotHead}</th>}
                {columns.map((k) => (
                  <th key={k} title={PARAMS[k].label}>{columnHead(k)}<small>{PARAMS[k].unit || " "}</small></th>
                ))}
                <th className="l">Operator</th>
                <th className="l">Remarks</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((e, i) => {
                // A flag on the whole entry is drawn as a bar and a mark at the
                // start of the row. The date and shift keep their plain text:
                // tinting the shift letter read as "this shift is wrong".
                const rowMark = marks.get(`${e.id}|*`);
                const rowWhat = rowMark ? describeMark(rowMark, true) : undefined;
                const label = entryLabel(e);
                // Two stored entries with one id would otherwise break the list.
                const key = seen.has(e.id) ? `${e.id}#${i}` : e.id;
                seen.add(e.id);
                const open = () => setView({ kind: "edit", id: e.id, askDelete: false, opened: e });
                return (
                  <tr
                    key={key}
                    className={`${styles.openRow} ${i > 0 && dateOf(visible[i - 1]) !== dateOf(e) ? "day-start" : ""}`}
                    tabIndex={0}
                    aria-haspopup="dialog"
                    title={`Open the entry for ${label}`}
                    onClick={open}
                    onKeyDown={(ev) => {
                      if (ev.target !== ev.currentTarget) return;
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        open();
                      }
                    }}
                  >
                    <td className={`l ${rowMark ? (rowMark.severity === "high" ? styles.rowHigh : styles.rowWarn) : ""}`} title={rowWhat}>
                      {rowMark && <Mark sev={rowMark.severity} />}
                      {dateOf(e) ? formatDate(dateOf(e)) : <span className="muted">{text(e.date).slice(0, 14) || "no date"}</span>}
                      {rowWhat && <span className="sr-only"> ({rowWhat})</span>}
                    </td>
                    {hasSlot && <td className="l">{(text(e.shift) || text(e.time)).slice(0, 8) || "–"}</td>}
                    {columns.map((k) => {
                      const mark = marks.get(`${e.id}|${k}`);
                      const what = mark ? describeMark(mark, false) : undefined;
                      return (
                        <td key={k} className={mark ? (mark.severity === "high" ? "bad" : "warn") : ""} title={what}>
                          {mark && <Mark sev={mark.severity} />}
                          {show(k, e.values?.[k])}
                          {what && <span className="sr-only"> ({what})</span>}
                        </td>
                      );
                    })}
                    <td className={`l ${styles.clipCell}`}>{text(e.operator) || "–"}</td>
                    <td className="l wrap">{text(e.remarks).slice(0, 300)}</td>
                    <td>
                      <button
                        className="btn sm" title="Delete entry" aria-label={`Delete the entry for ${label}`}
                        onClick={(ev) => { ev.stopPropagation(); setView({ kind: "edit", id: e.id, askDelete: true, opened: e }); }}
                      >
                        <Cross />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > visible.length && (
        <div className={styles.more}>
          <span className="muted small">
            Showing the newest {visible.length.toLocaleString("en-IN")} of {rows.length.toLocaleString("en-IN")}.
          </span>
          <button className="btn sm" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, rows.length - visible.length)} more
          </button>
        </div>
      )}

      {dialog}
    </div>
  );
}
