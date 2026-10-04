// Records one live answer from the reader for a sample page, into scripts/samples/recorded.json,
// so the sample still shows unsure cells and the model's notes when the reader is unavailable.
// Uses ONE live model call (free tier is rationed). Needs the app running with a key configured.
//   node scripts/samples/record-reading.mjs page-4.jpg [baseUrl]   (default http://localhost:3210)
// Then rerun scripts/make-samples.mjs to merge it into public/samples/truth.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
const base = (process.argv[3] || "http://localhost:3210").replace(/\/$/, "");
if (!file || !/^page-\d+\.jpg$/.test(file)) { console.error("Usage: node scripts/samples/record-reading.mjs page-N.jpg [baseUrl]"); process.exit(1); }
const truth = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "public", "samples", "truth.json"), "utf8"));
const page = truth.pages.find((p) => p.file === file);
if (!page) { console.error("Not in truth.json: " + file); process.exit(1); }
const jpg = fs.readFileSync(path.join(here, "..", "..", "public", "samples", file));
const res = await fetch(base + "/api/extract", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ imageDataUrl: "data:image/jpeg;base64," + jpg.toString("base64"), plantKind: page.plantKind, fallbackDate: page.fallbackDate }),
});
const d = await res.json().catch(() => null);
if (!res.ok || !d || d.ok !== true || !Array.isArray(d.rows) || d.rows.length === 0) { console.error("The reader did not give a usable answer (HTTP " + res.status + "). Nothing written."); process.exit(1); }
const recFile = path.join(here, "recorded.json");
const all = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8")) : {};
const today = new Date().toISOString().slice(0, 10);
const nice = new Date(today + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
all[file] = { model: d.model, recordedOn: today, label: `Reading recorded on ${nice} from ${d.model}`, rows: d.rows, unmappedColumns: d.unmappedColumns || [], notes: d.notes || [] };
fs.writeFileSync(recFile, JSON.stringify(all, null, 1));
console.log("Recorded " + d.rows.length + " rows for " + file + " from " + d.model);
