// Scores the live extractor against pages whose true values are known.
//
// Usage: start the app (npm run dev, with GEMINI_API_KEY set), then
//   node scripts/eval-extract.mjs [baseUrl] [--pages page-1.jpg,page-4.jpg] [--truth file] [--wait seconds]
//
//   baseUrl   default http://localhost:3000
//   --pages   only these files from the truth file (default: every page in it)
//   --truth   a truth file other than public/samples/truth.json; image paths
//             are taken relative to it. Use this for pages that must stay
//             outside the repo (real registers).
//   --wait    pause between pages, default 5 s (the free tier is rate limited)
//
// Truth format: { pages: [{ file, plantKind, fallbackDate, rows: ExtractedRow[],
//   uncertain?: [{ row, param }] }] }. Any parameter in lib/types.ts may appear;
// nothing here is specific to one kind of register. Cells listed in
// "uncertain" (1-based row) are ones the person who wrote the truth could not
// read with confidence: they are shown but not scored.
//
// Every page costs at least one model call, so run this sparingly:
// - the route allows 12 pages per 10 minutes per caller, and by default 40
//   model calls a day per server instance (EXTRACT_DAILY_LIMIT in
//   .env.example; a run from the server's own machine is held to that number
//   only, not to the smaller per-visitor share);
// - the free tier has its own daily request limit per model.
// The route answers a repeat of the same photo from memory for six hours, so
// a second run against the same server process scores the stored reading and
// costs nothing (the page line then says "repeat"). Restart the server to
// force a fresh reading, for example after changing the prompt.
// When the route refuses a page for a limit, its Retry-After is printed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const only = opt("pages")?.split(",").map((s) => s.trim()).filter(Boolean);
const truthPath = path.resolve(
  opt("truth") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "samples", "truth.json"),
);
const waitMs = Math.max(0, Number(opt("wait") ?? 5)) * 1000 || 0;
const base = (args[0] || "http://localhost:3000").replace(/\/$/, "");

const dir = path.dirname(truthPath);
const truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));
const pages = (Array.isArray(truth.pages) ? truth.pages : []).filter((p) => !only || only.includes(p.file));
if (pages.length === 0) {
  console.error(`No pages to score in ${truthPath}${only ? ` matching ${only.join(", ")}` : ""}.`);
  process.exit(1);
}

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const blank = () => ({ cells: 0, right: 0, wrongSure: 0, wrongUnsure: 0, missed: 0, invented: 0, low: 0 });
const total = blank();
const perParam = {};
const tally = (k, field) => {
  total[field]++;
  (perParam[k] ??= blank())[field]++;
};
const same = (a, b) => Math.abs(a - b) < 1e-9;
let failedPages = 0;

for (const [n, page] of pages.entries()) {
  if (n > 0 && waitMs) await new Promise((r) => setTimeout(r, waitMs));
  const file = path.join(dir, page.file);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime || !fs.existsSync(file)) {
    console.log(`\n${page.file}: SKIPPED (${mime ? "file not found" : "not a JPEG, PNG or WebP"})`);
    failedPages++;
    continue;
  }
  const b64 = fs.readFileSync(file).toString("base64");
  const t0 = Date.now();
  let data;
  let repeat = false;
  let retryAfter = null;
  try {
    const res = await fetch(`${base}/api/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageDataUrl: `data:${mime};base64,${b64}`, plantKind: page.plantKind ?? "STP", fallbackDate: page.fallbackDate }),
    });
    const text = await res.text();
    repeat = res.headers.get("x-jallog-reading") === "repeat";
    retryAfter = res.headers.get("retry-after");
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, code: `http_${res.status}`, message: text.slice(0, 200) };
    }
  } catch (e) {
    data = { ok: false, code: "network", message: String(e?.message ?? e) };
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!data?.ok) {
    console.log(`\n${page.file}: FAILED ${data?.code} ${data?.message}${retryAfter ? ` (retry after ${retryAfter} s)` : ""}`);
    failedPages++;
    continue;
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const want = Array.isArray(page.rows) ? page.rows : [];
  const uncertain = new Set((page.uncertain ?? []).map((u) => `${u.row}:${u.param}`));
  const p = { cells: 0, right: 0 };
  const issues = [];
  const unscored = [];
  let meta = 0;

  // Rows are compared by position: the extractor must return one row per
  // written row, in page order.
  for (let i = 0; i < Math.max(want.length, rows.length); i++) {
    const w = want[i];
    const g = rows[i];
    if (!w) {
      issues.push(`row ${i + 1}: not on the page, got ${JSON.stringify(g?.values ?? {})}`);
      for (const k of Object.keys(g?.values ?? {})) if (g.values[k] !== null) tally(k, "invented");
      continue;
    }
    for (const f of ["date", "shift", "time"]) {
      if ((w[f] ?? null) !== (g?.[f] ?? null)) {
        meta++;
        issues.push(`row ${i + 1} ${f}: want ${w[f] ?? null}, got ${g?.[f] ?? null}`);
      }
    }
    const keys = new Set([...Object.keys(w.values ?? {}), ...Object.keys(g?.values ?? {})]);
    for (const k of keys) {
      const wv = w.values?.[k] ?? null;
      const gv = g?.values?.[k] ?? null;
      const conf = g?.cellMeta?.[k]?.confidence;
      const raw = g?.cellMeta?.[k]?.raw;
      const shown = `${gv} (${conf ?? "no cell"}${raw !== undefined ? `, written "${raw}"` : ""})`;
      if (uncertain.has(`${i + 1}:${k}`)) {
        unscored.push(`row ${i + 1} ${k}: truth unsure (${wv}), got ${shown}`);
        continue;
      }
      if (conf === "low") tally(k, "low");
      if (wv === null && gv === null) continue;
      if (wv === null) {
        tally(k, "invented");
        issues.push(`row ${i + 1} ${k}: page is blank, got ${shown}`);
        continue;
      }
      p.cells++;
      tally(k, "cells");
      if (gv === null) {
        tally(k, "missed");
        issues.push(`row ${i + 1} ${k}: want ${wv}, got nothing`);
      } else if (same(wv, gv)) {
        p.right++;
        tally(k, "right");
      } else {
        tally(k, conf === "low" ? "wrongUnsure" : "wrongSure");
        issues.push(`row ${i + 1} ${k}: want ${wv}, got ${shown}`);
      }
    }
  }

  const pct = p.cells ? ` (${((p.right / p.cells) * 100).toFixed(1)}%)` : "";
  console.log(`\n${page.file} [${data.model}, ${repeat ? "repeat of a stored reading" : `${secs}s`}]: rows ${rows.length}/${want.length}, cells ${p.right}/${p.cells}${pct}, date/shift/time mismatches ${meta}`);
  console.log(`  unmapped: ${(data.unmappedColumns ?? []).join("; ") || "-"}`);
  console.log(`  notes: ${(data.notes ?? []).join(" | ") || "-"}`);
  issues.forEach((s) => console.log(`  - ${s}`));
  unscored.forEach((s) => console.log(`  ? ${s}`));
}

const pctTotal = total.cells ? ` (${((total.right / total.cells) * 100).toFixed(1)}%)` : "";
console.log(`\nTOTAL: ${total.right}/${total.cells} written cells correct${pctTotal}${failedPages ? `; ${failedPages} page(s) not read` : ""}`);
console.log(
  `wrong but marked unsure: ${total.wrongUnsure} · wrong and marked sure: ${total.wrongSure} · missed: ${total.missed} · invented: ${total.invented} · cells marked unsure overall: ${total.low}`,
);

const names = Object.keys(perParam).sort();
if (names.length) {
  const width = Math.max(...names.map((k) => k.length), 9);
  console.log(`\n${"parameter".padEnd(width)}  correct   wrong(unsure)  wrong(sure)  missed  invented  marked unsure`);
  for (const k of names) {
    const v = perParam[k];
    console.log(
      `${k.padEnd(width)}  ${`${v.right}/${v.cells}`.padEnd(8)}  ${String(v.wrongUnsure).padEnd(13)}  ${String(v.wrongSure).padEnd(11)}  ${String(v.missed).padEnd(6)}  ${String(v.invented).padEnd(8)}  ${v.low}`,
    );
  }
}
// A page that could not be read at all is a failed run, whatever the cells say.
process.exitCode = failedPages ? 1 : 0;
