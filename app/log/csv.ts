// Ordering and CSV export for the Log screen. Pure functions (no React, no
// browser), kept out of page.tsx because a Next page file may only export the
// page itself, and these are unit-tested (lib/__tests__/csv.test.ts).

import { cleanNumber, editedBefore, text } from "@/components/EntryDialog";
import { COLUMN_ORDER, PARAMS } from "@/lib/params";
import { isIsoDate } from "@/lib/store";
import type { LogEntry, LogPage } from "@/lib/types";

// Written as a character code: an invisible character in the source is easy to lose.
export const UTF8_BOM = String.fromCharCode(0xfeff);

const SHIFT_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

// "" when the stored date is missing or not a real calendar date.
export function dateOf(e: LogEntry): string {
  const d = text(e?.date);
  return isIsoDate(d) ? d : "";
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Register order: oldest first, entries without a usable date last (so that
// newest-first puts them at the top, where they get noticed and fixed).
export function byRegisterOrder(a: LogEntry, b: LogEntry): number {
  const da = dateOf(a);
  const db = dateOf(b);
  if (da !== db) return !da ? 1 : !db ? -1 : cmp(da, db);
  return (
    (SHIFT_RANK[text(a.shift)] ?? 3) - (SHIFT_RANK[text(b.shift)] ?? 3) ||
    cmp(text(a.time), text(b.time)) ||
    cmp(text(a.id), text(b.id))
  );
}

// A spreadsheet runs a cell that starts with = + - or @ as a formula, and an
// operator name or remark is whatever was written on the page. A leading
// single quote makes the cell plain text (CSV injection).
export function csvText(v: unknown): string {
  let s = text(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Readings are written from numbers JalLog holds, never from page text, so a
// negative value stays a number.
export function csvNumber(v: unknown): string {
  const n = cleanNumber(v);
  return n === null ? "" : String(n);
}

// A bundled sample page is generated data even when the live reader read it;
// its saved page record says so in "model" (see the capture screen).
function sourceOf(e: LogEntry, fileOf: Map<string, string>, samplePages: Set<string>): string {
  const id = text(e.pageId);
  if (!id) return "typed by hand";
  if (id === "seed") return "generated sample";
  if (samplePages.has(id)) return `generated sample page${fileOf.get(id) ? ` (${fileOf.get(id)})` : ""}`;
  return fileOf.get(id) || "photographed page";
}

export function toCsv(entries: LogEntry[], pages: LogPage[]): string {
  const fileOf = new Map<string, string>();
  const samplePages = new Set<string>();
  for (const p of Array.isArray(pages) ? pages : []) {
    if (!p || typeof p.id !== "string") continue;
    fileOf.set(p.id, text(p.fileName));
    if (/\bsample\b/i.test(text(p.model))) samplePages.add(p.id);
  }
  const cols = COLUMN_ORDER.filter((k) => entries.some((e) => cleanNumber(e.values?.[k]) !== null));
  const head = [
    "date", "shift", "time", "operator",
    ...cols.map((k) => `${k}${PARAMS[k].unit ? ` (${PARAMS[k].unit})` : ""}`),
    "remarks", "source", "changed_by_person", "digitised_at",
  ];
  const lines = [...entries].sort(byRegisterOrder).map((e) =>
    [
      csvText(e.date), csvText(e.shift), csvText(e.time), csvText(e.operator),
      ...cols.map((k) => csvNumber(e.values?.[k])),
      csvText(e.remarks), csvText(sourceOf(e, fileOf, samplePages)), csvText(editedBefore(e).join(" ")), csvText(e.capturedAt),
    ].join(","),
  );
  return [head.map(csvText).join(","), ...lines].join("\r\n");
}

// Letters and digits of any script are kept (a plant named in Hindi still
// gets its name in the file); everything else, including path and control
// characters, becomes a dash. A name with nothing usable falls back to "plant".
export function csvFileName(plantName: unknown, today: string): string {
  const slug = text(plantName)
    .normalize("NFC")
    .replace(new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu"), "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
    .toLowerCase();
  return `${slug || "plant"}-log-${today}.csv`;
}
