// Pages 1-3 are three-shift lab-style sheets (plant "shift"); page 4 is a one-row-a-day meter register (plant "daily").
// Regenerates public/samples/page-{1,2,3,4}.jpg and public/samples/truth.json.
// Run:  node scripts/make-samples.mjs
// Needs puppeteer-core (NOT in this project's package.json) and Edge/Chrome installed, plus network for Google Fonts.
//   Set TOOLS_DIR to a folder where `npm i puppeteer-core` was run (default: this project folder),
//   and optionally BROWSER_PATH to msedge.exe / chrome.exe.
// Everything random uses a seeded PRNG, so reruns give the same pages and the same truth.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..", "public", "samples");
// Defaults to this project, for anyone who has run `npm i --no-save puppeteer-core` here.
const TOOLS_DIR = process.env.TOOLS_DIR || path.resolve(here, "..");
const require = createRequire(path.join(TOOLS_DIR, "x.js"));
const puppeteer = require("puppeteer-core");
const BROWSER =
  process.env.BROWSER_PATH ||
  [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find((p) => fs.existsSync(p));

// ---------- seeded PRNG ----------
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mk = (seed) => {
  const r = mulberry32(seed);
  return {
    f: (lo, hi) => lo + (hi - lo) * r(),
    i: (lo, hi) => Math.floor(lo + (hi - lo + 1) * r()),
  };
};

const DEC = { inletFlow: 0, outletFlow: 0, phInlet: 1, phOutlet: 1, doAeration: 1, mlss: 0, sv30: 0, codOutlet: 0, bodOutlet: 0, tssOutlet: 0, residualChlorine: 1, blowerHours: 1, energyKwh: 0 };
const txt = (k, v) => (v === null ? "" : v.toFixed(DEC[k]));
const pad = (n) => String(n).padStart(2, "0");
const iso = (m, d) => `2026-${pad(m)}-${pad(d)}`;
const ddmmyy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}`;
const addDay = (m, d, n) => { const t = new Date(Date.UTC(2026, m - 1, d + n)); return [t.getUTCMonth() + 1, t.getUTCDate()]; };

// ---------- fonts ----------
const FONTS = {
  Kalam: { scale: 1.0 },
  Caveat: { scale: 1.3 },
  "Patrick Hand": { scale: 1.08 },
  "Shadows Into Light": { scale: 1.28 },
  "Gochi Hand": { scale: 0.98 },
  "Reenie Beanie": { scale: 1.5 },
};
const GF = "https://fonts.googleapis.com/css2?" +
  ["Kalam:wght@400;700", "Caveat:wght@500", "Patrick+Hand", "Shadows+Into+Light", "Gochi+Hand", "Reenie+Beanie"].map((f) => "family=" + f).join("&") +
  "&display=block";

// ---------- value generation for 250 KLD page ----------
function genStpRows(seed, start, days, firstEnergy, ops) {
  const R = mk(seed);
  const rows = [];
  let energy = firstEnergy;
  let mlss = 3150;
  for (let d = 0; d < days; d++) {
    const [m, dd] = addDay(start[0], start[1], d);
    ["A", "B", "C"].forEach((sh, s) => {
      const inlet = R.i(sh === "C" ? 60 : 72, sh === "A" ? 108 : sh === "B" ? 104 : 84);
      const outlet = Math.round(inlet * R.f(0.94, 0.97));
      mlss = Math.min(3750, Math.max(2650, mlss + R.i(-90, 90)));
      const ml = Math.round(mlss / 10) * 10;
      energy += R.i(62, 118);
      rows.push({
        date: iso(m, dd), shift: sh, time: null, op: ops[s],
        vals: {
          inletFlow: inlet, outletFlow: outlet,
          phInlet: +R.f(6.9, 7.7).toFixed(1), phOutlet: +R.f(7.0, 7.8).toFixed(1),
          doAeration: +R.f(1.6, 3.4).toFixed(1), mlss: ml,
          sv30: Math.round((ml * R.i(92, 140)) / 1000),
          codOutlet: R.i(48, 98), bodOutlet: null, tssOutlet: R.i(12, 36),
          residualChlorine: +R.f(0.4, 0.8).toFixed(1),
          blowerHours: R.i(11, 16) / 2, energyKwh: energy,
        },
        strike: {}, remark: null, firstOfDay: s === 0, dayIdx: d,
      });
    });
  }
  return rows;
}

// ---------- page definitions ----------
const OPS1 = [
  { name: "Ramesh", font: "Kalam", ink: "#1c3d9e" },
  { name: "Suresh", font: "Patrick Hand", ink: "#202024" },
  { name: "Mahesh", font: "Caveat", ink: "#14297a" },
];
const OPS2 = [
  { name: "Ramesh", font: "Kalam", ink: "#1c3d9e" },
  { name: "Dinesh", font: "Gochi Hand", ink: "#23232a" },
  { name: "Mahesh", font: "Shadows Into Light", ink: "#16318f" },
];
const OPS3 = [
  { name: "Anil", font: "Patrick Hand", ink: "#1a3a99" },
  { name: "Vikram", font: "Gochi Hand", ink: "#222226" },
];

const STP_COLS = [
  { t: "date", head: ["Date"], w: 92 },
  { t: "shift", head: ["Shift"], w: 46 },
  ...[
    ["inletFlow", "Inlet Flow", "(m³)"], ["outletFlow", "Outlet Flow", "(m³)"],
    ["phInlet", "pH Inlet", ""], ["phOutlet", "pH Outlet", ""],
    ["doAeration", "DO", "(mg/L)"], ["mlss", "MLSS", "(mg/L)"], ["sv30", "SV30", "(ml/L)"],
    ["codOutlet", "COD Out", ""], ["bodOutlet", "BOD Out", ""], ["tssOutlet", "TSS Out", ""],
    ["residualChlorine", "Res. Cl₂", ""], ["blowerHours", "Blower Hrs", ""],
    ["energyKwh", "Energy Meter", "(kWh)"],
  ].map(([k, a, b]) => ({ t: "val", key: k, head: [a, b].filter(Boolean), w: k === "energyKwh" ? 92 : 78 })),
  { t: "op", head: ["Operator"], w: 92 },
  { t: "rem", head: ["Remarks"], w: 200 },
];

function page1() {
  const rows = genStpRows(101, [9, 28], 4, 48210, OPS1);
  rows[5].vals.bodOutlet = 18;
  rows[4].remark = "blower-2 belt changed";
  rows[9].remark = "power cut 2 hrs";
  return {
    file: "page-1.jpg", title: "Clean, typical 3-shift STP page",
    description: "Aravali Residency STP, 250 KLD. 12 rows, 28 Sep to 1 Oct 2026, shifts A, B and C. BOD is filled on one row only, there are two remarks, and the date is written on the first shift of each day (blank or a ditto mark after).",
    plant: "Aravali Residency STP", cap: "250 KLD", month: "September – October 2026", cols: STP_COLS, rows,
    vp: [1600, 1200], rowH: 56, sheetW: 1486, rot: -1.7, rx: 2.0, ry: -1.4, dark: 0.22, seed: 11, dateMode: "first", stain: null, kind: "stp",
  };
}

function page2() {
  const rows = genStpRows(202, [10, 2], 4, 49420, OPS2);
  // night shift of day 2 identical to previous row (readings only; the energy meter still rises)
  const keep = rows[5].vals.energyKwh;
  rows[5].vals = { ...rows[4].vals, energyKwh: keep };
  // planted values
  rows[7].vals.tssOutlet = 142;
  rows[9].vals.bodOutlet = 22;
  // blanks
  rows[2].vals.sv30 = null; rows[6].vals.residualChlorine = null;
  rows[8].vals.codOutlet = null; rows[11].vals.blowerHours = null;
  // struck-through corrections: truth = corrected value
  rows[1].strike = { doAeration: "2.8" }; rows[1].vals.doAeration = 2.3;
  rows[10].strike = { phOutlet: "7.9" }; rows[10].vals.phOutlet = 7.4;
  rows[3].remark = "ब्लोअर 2 बंद रहा";
  rows[7].remark = "sludge zyada tha";
  return {
    file: "page-2.jpg", title: "Messy 3-shift STP page",
    description: "The same form, 2 to 5 Oct 2026. Two struck-through corrections, four blank cells, a night shift identical to the row before, one outlet TSS of 142, remarks in Hindi and Hinglish, a skewed photo and a coffee-ring stain.",
    plant: "Aravali Residency STP", cap: "250 KLD", month: "October 2026", cols: STP_COLS, rows,
    vp: [1600, 1200], rowH: 56, sheetW: 1480, rot: 2.6, rx: 3.0, ry: 2.2, dark: 0.4, seed: 22, dateMode: "first", stain: { x: 1180, y: 18, s: 190 }, kind: "stp",
  };
}

function page3() {
  const R = mk(303);
  const rows = [];
  let mlss = 2980;
  for (let d = 0; d < 4; d++) {
    const [m, dd] = addDay(9, 29, d);
    [["08:00", 0], ["20:00", 1]].forEach(([time, s]) => {
      mlss = Math.min(3600, Math.max(2600, mlss + R.i(-80, 80)));
      rows.push({
        date: iso(m, dd), shift: null, time, op: OPS3[s], opSign: true,
        vals: {
          outletFlow: R.i(34, 52), phInlet: +R.f(6.9, 7.6).toFixed(1), phOutlet: +R.f(7.1, 7.8).toFixed(1),
          doAeration: +R.f(1.7, 3.3).toFixed(1), mlss: Math.round(mlss / 10) * 10,
          residualChlorine: +R.f(0.4, 0.8).toFixed(1), blowerHours: R.i(10, 16) / 2,
        },
        extra: { sludge: R.i(4, 12) * 50 }, strike: {}, remark: null, dayIdx: d,
      });
    });
  }
  const cols = [
    { t: "date", head: ["Date"], w: 100 }, { t: "time", head: ["Time"], w: 70 },
    { t: "val", key: "outletFlow", head: ["Flow Meter Reading –", "Treated Water", "(m³/shift)"], w: 118 },
    { t: "val", key: "phInlet", head: ["Raw Sewage", "pH"], w: 80 },
    { t: "val", key: "phOutlet", head: ["Final Outlet", "pH"], w: 80 },
    { t: "val", key: "doAeration", head: ["D.O.", "Aeration Tank"], w: 86 },
    { t: "val", key: "mlss", head: ["M.L.S.S."], w: 80 },
    { t: "val", key: "residualChlorine", head: ["Chlorine", "Residual", "(ppm)"], w: 86 },
    { t: "val", key: "blowerHours", head: ["Air Blower", "Running Hrs"], w: 90 },
    { t: "extra", key: "sludge", head: ["Sludge", "Wasted (L)"], w: 90 },
    { t: "sign", head: ["Sign."], w: 100 },
  ];
  return {
    file: "page-3.jpg", title: "Different layout, Sample Hospital STP",
    description: "Sample Hospital STP, 100 KLD. Portrait page, 8 rows, readings at 08:00 and 20:00, 29 Sep to 2 Oct 2026. Columns are worded and ordered differently, with a sludge-volume column JalLog does not track and a signature column. It is another plant's page: use it to try the reader, then discard it.",
    plant: "Sample Hospital STP", cap: "100 KLD", month: "Sept. – Oct. 2026", cols, rows,
    vp: [1200, 1600], rowH: 92, sheetW: 1086, rot: -2.2, rx: 2.4, ry: 1.6, dark: 0.3, seed: 33, dateMode: "all", stain: null, kind: "hosp", minH: 1300,
  };
}

// ---------- page 4: one row a day, meters and dosing (no shifts, no lab values) ----------
// Truth units: dosing is stored in KILOGRAMS (500g = 0.5), energyKwh is the CLOSE reading, runHours = close - start.
const TWIN_FROM = 4; // 25 Sep: outlet reading written the same as inlet on every row from here
const STEP_FROM = 6; // 27 Sep: energy meter rises by exactly 3 on every row from here (8 rows)
function page4() {
  const R = mk(404);
  const rows = [];
  let inlet = 18468, outlet = 17112, energy = 91244;
  const dose = new Set([0, 3, 7, 10]); // every third or fourth day
  const sludgeDays = new Set([0, 7]);
  const long = new Set([4, 10]); // closed at 4 pm instead of 3 pm
  for (let d = 0; d < 14; d++) {
    const [m, dd] = addDay(9, 21, d);
    if (d > 0) {
      const di = R.i(6, 10);
      inlet += di;
      outlet += di - R.i(1, 2); // outlet rises a little less than inlet
    }
    // Written-in irregularities (see TWIN_FROM, STEP_FROM). The random draws above
    // still happen, so the other rows keep their values.
    if (d >= TWIN_FROM) outlet = inlet;
    const eStart = energy;
    energy += R.i(9, 14);
    if (d >= STEP_FROM) energy = eStart + 3;
    const dosed = dose.has(d);
    // [text written, kilograms]
    const lime = dosed ? (d === 7 ? ["1 kg", 1] : ["500g", 0.5]) : null;
    const alum = dosed ? ["1 kg", 1] : null;
    const chl = dosed ? ["50g", 0.05] : null;
    rows.push({
      date: iso(m, dd), dstr: `${dd}-${m}-26`, n: d + 1,
      inlet, outlet, start: "9 am", close: long.has(d) ? "4 pm" : "3 pm", run: long.has(d) ? 7 : 6,
      lime, alum, chl, eStart, eClose: energy,
      sludge: sludgeDays.has(d) ? ["2 kg", 2] : null,
      remark: d === 5 ? "pump serviced" : null,
    });
  }
  // one overwritten digit (last digit of the inlet reading on row 9); the final digit is the truth and stays readable
  const ow = 8;
  const fin = rows[ow].inlet % 10;
  rows[ow].owOld = (fin + 3) % 10;
  return {
    file: "page-4.jpg", title: "One row a day, small plant meter register",
    description: "Sample Clinic STP, 10 KLD. One row a day, 21 Sep to 4 Oct 2026, no shifts and no lab values: flow meter readings, plant start and close time, lime, alum and chlorine dosing (written in g or kg), energy meter start and close readings, sludge, and a signature. Dates are written D-M-YY and one digit is overwritten. Written into it, as in the real register that shaped this plant kind: from 25 Sep the outlet reading is the same as the inlet reading on every row, and from 27 Sep the energy meter rises by exactly 3 on every row.",
    plant: "Sample Clinic STP (10 KLD)", month: "September / October 2026", rows, seed: 44, vp: [1700, 1180], rot: 0.9,
    custom: true, ow,
  };
}

function buildHtml4(P) {
  const J = mk(P.seed * 7 + 1);
  const INK = "#1b2fa6";
  const FONT = "Kalam";
  const jit = () => ({ sz: J.f(0.92, 1.08), dy: J.f(-3, 3), dx: J.f(-2, 2), rot: J.f(-3, 3), op: J.f(0.82, 0.95) });
  const hw = (text, base, extra = "", font = FONT) => {
    const j = jit();
    const sz = (base * FONTS[font].scale * j.sz).toFixed(1);
    return `<span class="h" data-font="${font}" style="font-family:'${font}';font-size:${sz}px;color:${INK};opacity:${j.op.toFixed(2)};text-shadow:0 0 0.6px ${INK};transform:translate(${j.dx.toFixed(1)}px,${j.dy.toFixed(1)}px) rotate(${j.rot.toFixed(1)}deg);${extra}">${text}</span>`;
  };
  const dash = () => hw("-", 26);
  const w = (v) => (v ? hw(v[0], 24) : dash());
  const sig = () =>
    hw("Sunil", 30, `letter-spacing:1px;margin-top:-4px;`, "Reenie Beanie") +
    `<svg class="sig" width="90" height="22" viewBox="0 0 90 22"><path d="M4 ${J.i(12, 17)} q${J.i(14, 22)} -${J.i(10, 14)} ${J.i(30, 40)} 0 t${J.i(20, 28)} 1" fill="none" stroke="${INK}" stroke-width="1.7" opacity=".7" stroke-linecap="round"/></svg>`;
  // overwritten last digit: an old digit sits under the new one, offset a little, same pen
  const num = (r, key, i) => {
    const s = String(r[key]);
    if (i === P.ow && key === "inlet") {
      const body = s.slice(0, -1), last = s.slice(-1);
      return hw(`${body}<span class="ow"><span class="under">${r.owOld}</span>${last}</span>`, 25);
    }
    return hw(s, 25);
  };
  const cols = [56, 110, 100, 100, 90, 90, 100, 90, 100, 112, 112, 100, 130, 190];
  const colgroup = cols.map((c) => `<col style="width:${c}px">`).join("");
  const body = P.rows
    .map((r, i) => `<tr style="height:58px">
<td>${hw(r.n, 17)}</td><td>${hw(r.dstr, 21)}</td>
<td>${num(r, "inlet", i)}</td><td>${num(r, "outlet", i)}</td>
<td>${hw(r.start, 23)}</td><td>${hw(r.close, 23)}</td>
<td>${w(r.lime)}</td><td>${w(r.alum)}</td><td>${w(r.chl)}</td>
<td>${hw(r.eStart, 23)}</td><td>${hw(r.eClose, 23)}</td>
<td>${r.sludge ? hw(r.sludge[0], 24) : ""}</td>
<td class="c-sign">${sig()}</td>
<td class="c-rem">${r.remark ? hw(r.remark, 19, "text-align:left;") : ""}</td></tr>`)
    .join("");
  const [vw, vh] = P.vp;
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${GF}">
<style>
*{box-sizing:border-box}
html,body{margin:0;width:${vw}px;height:${vh}px;overflow:hidden}
body{background:#cfcfcb;position:relative}
#sheet{position:absolute;inset:-40px;padding:96px 90px 40px 74px;background:#f6f5f0;transform:rotate(${P.rot}deg);
 font-family:Arial,Helvetica,sans-serif;color:#1c1c1e;overflow:hidden;
 box-shadow:inset 40px 0 70px -40px rgba(60,60,50,.22),inset 0 -50px 80px -50px rgba(60,60,50,.18)}
#sheet:before{content:"";position:absolute;inset:0;background:${NOISE};opacity:.30;mix-blend-mode:multiply;pointer-events:none;z-index:5}
.hole{position:absolute;top:70px;width:34px;height:34px;border-radius:50%;background:#cfcfcb;box-shadow:inset 2px 3px 5px rgba(0,0,0,.45)}
.speck{position:absolute;border-radius:50%;background:#333;opacity:.55}
.frame{border:1.6px solid #222;width:${cols.reduce((a, c) => a + c, 0)}px;margin-left:60px}
.ttl{text-align:center;font-weight:bold;font-size:28px;padding:6px 0 4px;border-bottom:1.6px solid #222}
.meta{display:flex;justify-content:space-between;font-size:19px;padding:7px 10px;border-bottom:1.6px solid #222}
table{border-collapse:collapse;table-layout:fixed;width:${cols.reduce((a, c) => a + c, 0)}px;margin:0 0 -1.6px -1.6px}
th,td{border:1.5px solid #222;padding:0}
th{font-weight:normal;font-size:17px;line-height:1.15;padding:3px;height:44px}
th.g{height:56px}
td{position:relative;text-align:center;vertical-align:middle;overflow:hidden;white-space:nowrap}
td.c-rem{text-align:left;padding-left:6px}
.h{display:inline-block;white-space:nowrap}
.ow{position:relative;display:inline-block}
.ow .under{position:absolute;left:3px;top:1px;opacity:.8;font-size:1.12em;transform:rotate(9deg);filter:blur(.3px)}
.sig{position:absolute;left:20px;top:32px}
.gen{position:absolute;z-index:7;left:134px;top:1128px;font:15px Arial,Helvetica,sans-serif;color:#6b2a1a}
</style></head><body>
<div id="sheet">
<div class="hole" style="left:560px"></div><div class="hole" style="left:1060px"></div>
<div class="speck" style="left:250px;top:44px;width:5px;height:5px"></div><div class="speck" style="left:1330px;top:1040px;width:11px;height:9px"></div>
<div class="frame">
<div class="ttl">STP Log Book</div>
<div class="meta"><span>Plant: <b>${P.plant}</b></span><span>Month: <b>${P.month}</b></span></div>
<table><colgroup>${colgroup}</colgroup><thead>
<tr><th rowspan="2">S.<br>No.</th><th rowspan="2">Date</th><th colspan="2" class="g">Flow Meter<br>Reading</th><th colspan="2" class="g">Plant Operation<br>Time</th><th colspan="3" class="g">Chemical Dosing<br>(Kg./Gms.)</th><th colspan="2" class="g">Energy Meter<br>Reading</th><th rowspan="2">Sludge Qty.<br>(In Kgs.)</th><th rowspan="2">Operator<br>Signature</th><th rowspan="2">Remarks</th></tr>
<tr><th>Inlet</th><th>Outlet</th><th>Start</th><th>Close</th><th>Lime</th><th>Alum</th><th>Chlorine</th><th>Start</th><th>Close</th></tr>
</thead><tbody>${body}</tbody></table>
</div>
<div class="gen">Generated sample page, not a real plant’s record</div>
</div></body></html>`;
}

function truthRow4(r) {
  return {
    date: r.date, shift: null, time: null, operator: "Sunil",
    values: {
      inletTotaliser: r.inlet, outletTotaliser: r.outlet, runHours: r.run,
      limeKg: r.lime ? r.lime[1] : null, alumKg: r.alum ? r.alum[1] : null, chlorineKg: r.chl ? r.chl[1] : null,
      energyKwh: r.eClose, sludgeKg: r.sludge ? r.sludge[1] : null,
    },
    cellMeta: {}, remarks: r.remark,
  };
}

// ---------- HTML ----------
const NOISE = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' seed='5'/><feColorMatrix values='0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.2  0 0 0 0.55 0'/></filter><rect width='400' height='400' filter='url(%23n)'/></svg>")`;
const BLOTCH = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='900' height='900'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.004' numOctaves='3' seed='9'/><feColorMatrix values='0 0 0 0 0.5  0 0 0 0 0.42  0 0 0 0 0.25  0 0 0 0.9 -0.2'/></filter><rect width='900' height='900' filter='url(%23n)'/></svg>")`;

function buildHtml(P) {
  const J = mk(P.seed * 7 + 1);
  const jit = () => ({ sz: J.f(0.9, 1.1), dy: J.f(-3, 3), dx: J.f(-2, 2), rot: J.f(-2, 2), op: J.f(0.8, 0.96) });
  const hw = (text, op, base, extra = "") => {
    const j = jit();
    const sz = (base * FONTS[op.font].scale * j.sz).toFixed(1);
    return `<span class="h" data-font="${op.font}" style="font-family:'${op.font}';font-size:${sz}px;color:${op.ink};opacity:${j.op.toFixed(2)};text-shadow:0 0 0.7px ${op.ink};transform:translate(${j.dx.toFixed(1)}px,${j.dy.toFixed(1)}px) rotate(${j.rot.toFixed(1)}deg);--ink:${op.ink};${extra}">${op.font === "Shadows Into Light" ? text.replace(/\./g, '<i class="dt"></i>') : text}</span>`;
  };
  const cell = (c, r) => {
    const op = r.op;
    switch (c.t) {
      case "date": {
        const show = P.dateMode === "all" || r.firstOfDay;
        if (show) return hw(ddmmyy(r.date), op, 19);
        // ditto on alternate days, blank otherwise
        return r.dayIdx % 2 === 1 ? hw("\"", op, 24) : "";
      }
      case "shift": return hw(r.shift, op, 24);
      case "time": return hw(r.time, op, 21);
      case "op": return hw(r.op.name, op, 19);
      case "rem": return r.remark ? hw(r.remark, op, 18, "text-align:left;line-height:1.05;display:block;") : "";
      case "val": {
        const v = r.vals[c.key];
        if (r.strike[c.key]) {
          const old = hw(r.strike[c.key], op, 12, "position:relative;");
          const j = J.f(-3, 3);
          return `<span class="strk"><span class="old">${old}<i style="transform:rotate(${(-8 + j).toFixed(1)}deg);background:${op.ink}"></i></span>${hw(txt(c.key, v), op, 24)}</span>`;
        }
        return v === null ? "" : hw(txt(c.key, v), op, c.key === "energyKwh" ? 21 : 23);
      }
      case "extra": return hw(String(r.extra[c.key]), op, 23);
      case "sign": {
        const ini = r.op.name[0] + (r.op.name === "Anil" ? "K" : "S");
        return hw(ini, { font: "Reenie Beanie", ink: op.ink }, 30, `letter-spacing:1px;`) +
          `<svg class="sig" width="70" height="26" viewBox="0 0 70 26"><path d="M2 ${J.i(14, 20)} q${J.i(8, 16)} -${J.i(14, 20)} ${J.i(24, 34)} 0 t${J.i(18, 26)} 2 t${J.i(10, 20)} -4" fill="none" stroke="${op.ink}" stroke-width="1.8" opacity=".75" stroke-linecap="round"/></svg>`;
      }
    }
    return "";
  };
  const colgroup = P.cols.map((c) => `<col style="width:${c.w}px">`).join("");
  const head = P.cols.map((c) => `<th>${c.head.map((l, k) => (k === 0 ? `<b>${l}</b>` : `<small>${l}</small>`)).join("<br>")}</th>`).join("");
  const body = P.rows.map((r, i) => `<tr style="height:${P.rowH}px">${P.cols.map((c) => `<td class="c-${c.t}">${cell(c, r, i)}</td>`).join("")}</tr>`).join("");
  const sheetW = P.sheetW;
  const stain = P.stain
    ? `<div class="stain" style="left:${P.stain.x}px;top:${P.stain.y}px;width:${P.stain.s}px;height:${P.stain.s}px"></div>`
    : "";
  const [vw, vh] = P.vp;
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${GF}">
<style>
*{box-sizing:border-box}
html,body{margin:0;width:${vw}px;height:${vh}px;overflow:hidden}
body{background:radial-gradient(ellipse at 30% 20%,#4a3a2c 0,#2a2018 55%,#150f0b 100%);perspective:2400px;position:relative}
body:before{content:"";position:absolute;inset:0;background:${NOISE};opacity:.5;mix-blend-mode:multiply}
#sheet{position:absolute;left:${(vw - sheetW) / 2}px;top:${(vh - (P.minH || 1050)) / 2 + 20}px;width:${sheetW}px;min-height:${P.minH || 1050}px;
 background:#f1ece0;padding:30px 34px 28px;overflow:hidden;
 transform:rotateZ(${P.rot}deg) rotateX(${P.rx}deg) rotateY(${P.ry}deg);
 box-shadow:${P.rot > 0 ? "-" : ""}28px 34px 60px rgba(0,0,0,${P.dark + 0.35}),0 0 0 1px rgba(0,0,0,.25);
 color:#2a2a2e;font-family:'Times New Roman',Times,serif}
#sheet:before{content:"";position:absolute;inset:0;background:${NOISE},${BLOTCH};opacity:.55;mix-blend-mode:multiply;pointer-events:none;z-index:5}
#light{position:absolute;inset:0;z-index:6;pointer-events:none;
 background:linear-gradient(${P.rot > 0 ? 100 : 80}deg,rgba(255,250,220,.22) 0%,rgba(255,255,255,0) 38%,rgba(0,0,0,${P.dark * 0.55}) 100%),
 radial-gradient(ellipse at 25% 10%,rgba(255,255,235,.25),rgba(0,0,0,0) 55%);
 box-shadow:inset ${P.rot > 0 ? "-" : ""}70px 0 90px -50px rgba(40,25,10,${P.dark + 0.1}),inset 0 -60px 80px -50px rgba(40,25,10,${P.dark * 0.8})}
.ttl{text-align:center;font-weight:bold;font-size:30px;letter-spacing:2px;opacity:.82;filter:blur(.3px)}
.meta{display:flex;justify-content:space-between;font-size:20px;margin:12px 4px 14px;opacity:.8;filter:blur(.3px)}
.meta span u{display:inline-block;min-width:220px;text-decoration:none;border-bottom:1.5px solid #333;padding:0 6px}
table{border-collapse:collapse;table-layout:fixed;width:${P.cols.reduce((a, c) => a + c.w, 0)}px;opacity:.88}
th,td{border:1.6px solid rgba(35,35,40,.85);padding:0}
th{background:rgba(120,110,80,.07);height:${P.kind === "hosp" ? 112 : 84}px;font-weight:normal;font-size:16px;line-height:1.15;padding:2px;filter:blur(.25px)}
th b{font-size:17px}th small{font-size:14px}
td{position:relative;text-align:center;vertical-align:middle;overflow:hidden;white-space:nowrap}
td.c-rem{text-align:left;padding-left:6px;white-space:normal}
.h{display:inline-block;white-space:nowrap}
.dt{display:inline-block;width:4.5px;height:4.5px;border-radius:50%;background:var(--ink);margin:0 1.5px;vertical-align:baseline}
.strk{display:inline-flex;align-items:center;gap:11px}
.old{position:relative;display:inline-block}
.old i{position:absolute;left:-3px;right:-3px;top:50%;height:2.2px;border-radius:2px;opacity:.85}
.sig{position:absolute;left:14px;top:60px;opacity:.9}
td.c-sign{position:relative}
.foot{display:flex;justify-content:space-between;margin:34px 10px 0;font-size:19px;opacity:.8;filter:blur(.3px)}
.foot span{display:inline-block;width:300px;border-top:1.5px solid #333;text-align:center;padding-top:4px}
.gen{position:absolute;z-index:7;left:34px;bottom:10px;font:15px Arial,Helvetica,sans-serif;color:#6b2a1a}
.stain{position:absolute;z-index:4;border-radius:50%;pointer-events:none;
 background:radial-gradient(circle,rgba(120,70,20,0) 56%,rgba(120,70,20,.30) 62%,rgba(105,58,14,.42) 66%,rgba(120,70,20,.16) 71%,rgba(120,70,20,0) 76%),radial-gradient(circle,rgba(150,95,40,.07) 0,rgba(150,95,40,.07) 58%,rgba(0,0,0,0) 60%);
 mix-blend-mode:multiply;transform:rotate(20deg) scaleY(.93)}
</style></head><body>
<div id="sheet">
<div class="ttl">SEWAGE TREATMENT PLANT – DAILY LOG BOOK</div>
<div class="meta"><span>Plant: <b>${P.plant}</b> &nbsp;(${P.cap})</span><span>Month: <b>${P.month}</b></span><span>Page No. <u></u></span></div>
<table><colgroup>${colgroup}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="foot"><span>Operator Signature</span><span>Supervisor Signature</span></div>
${stain}
<div class="gen">Generated sample page, not a real plant’s record</div>
<div id="light"></div>
</div></body></html>`;
}

// ---------- truth ----------
function truthRow(P, r) {
  const keys = P.cols.filter((c) => c.t === "val").map((c) => c.key);
  const values = {};
  for (const k of keys) values[k] = r.vals[k] === undefined ? null : r.vals[k];
  return {
    date: r.date, shift: r.shift, time: r.time,
    operator: r.opSign ? null : r.op.name,
    values, cellMeta: {}, remarks: r.remark,
  };
}

// ---------- main ----------
fs.mkdirSync(OUT, { recursive: true });
const pages = [page1(), page2(), page3(), page4()];
const browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ["--no-sandbox", "--hide-scrollbars"] });
const truth = { pages: [] };
const recFile = path.join(here, "samples", "recorded.json");
const recorded = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8")) : {};
for (const P of pages) {
  const html = P.custom ? buildHtml4(P) : buildHtml(P);
  fs.writeFileSync(path.join(OUT, "_debug-" + P.file.replace(".jpg", ".html")), html);
  const pg = await browser.newPage();
  await pg.setViewport({ width: P.vp[0], height: P.vp[1], deviceScaleFactor: 1 });
  await pg.setContent(html, { waitUntil: "networkidle0", timeout: 60000 });
  const info = await pg.evaluate(async () => {
    await document.fonts.ready;
    const used = [...new Set([...document.querySelectorAll(".h")].map((e) => e.dataset.font))];
    const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
    const sheet = document.getElementById("sheet").getBoundingClientRect();
    const over = [...document.querySelectorAll("td")].filter((t) => t.scrollWidth > t.clientWidth + 1 || t.scrollHeight > t.clientHeight + 1).length;
    return { used, loaded: [...new Set(loaded)], ok: used.map((f) => [f, document.fonts.check(`20px "${f}"`)]), rect: [sheet.left, sheet.top, sheet.right, sheet.bottom], over, vw: innerWidth, vh: innerHeight };
  });
  console.log(P.file, JSON.stringify(info));
  const missing = info.used.filter((f) => !info.loaded.includes(f));
  if (missing.length) throw new Error("Fonts failed to load: " + missing.join(", "));
  await pg.screenshot({ path: path.join(OUT, P.file), type: "jpeg", quality: 80 });
  await pg.close();
  fs.unlinkSync(path.join(OUT, "_debug-" + P.file.replace(".jpg", ".html")));
  // "rows" is what is written on the page (the truth, used for scoring). "recorded" is one real answer
  // from the reader, kept so the review can show unsure cells and notes without a live call. It is only
  // kept for a page whose image has not changed since: see scripts/samples/record-reading.mjs.
  const entry = { file: P.file, title: P.title, description: P.description, plantKind: "STP", fallbackDate: P.rows[0].date, rows: P.rows.map((r) => (P.custom ? truthRow4(r) : truthRow(P, r))), plant: P.custom ? "daily" : "shift" };
  if (recorded[P.file]) entry.recorded = recorded[P.file];
  truth.pages.push(entry);
}
await browser.close();
fs.writeFileSync(path.join(OUT, "truth.json"), JSON.stringify(truth, null, 2));
console.log("done");
