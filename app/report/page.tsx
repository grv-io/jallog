"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CATEGORY_LABEL } from "@/components/FlagList";
import { PARAMS } from "@/lib/params";
import {
  PARTIAL_MONTH_DAYS, buildReport, defaultMonth, entriesPerDay, flagsForMonth, limitBreakdown, limitBreakdownText, limitText,
  monthStats, reportNotes, shortDate, strayIdsFrom, suspectValuesFrom, undatedCount,
} from "@/lib/report";
import { demoKindOf, formatDate, useStore } from "@/lib/store";
import type { LogEntry, ParamKey } from "@/lib/types";
import styles from "./report.module.css";

// Every figure on this page is computed in lib/report.ts (and unit-tested
// there). This file only lays the figures out.

const monthLabel = (ym: string) => formatDate(`${ym}-01`, { month: "long", year: "numeric" });

function num(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  try {
    return v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  } catch {
    return v.toFixed(decimals);
  }
}

// encodeURIComponent throws on a lone surrogate (half an emoji pasted into
// the plant name); that must not take the report down.
function encode(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return encodeURIComponent(text.replace(/[\uD800-\uDFFF]/g, ""));
  }
}

const withUnit = (k: ParamKey) => (
  <>
    {PARAMS[k].label}
    {PARAMS[k].unit && <span className="muted"> ({PARAMS[k].unit})</span>}
  </>
);

const DOSED: ParamKey[] = ["limeKg", "alumKg", "chlorineKg"];
// Columns whose stored figure is a conversion of what the page says: grams
// become kilograms, a start and a close time become hours.
const CONVERTED: ParamKey[] = ["limeKg", "alumKg", "chlorineKg", "sludgeKg", "runHours"];

export default function ReportPage() {
  const { ready, plant, entries, pages, checks } = useStore();
  const perDay = entriesPerDay(plant);
  const stats = useMemo(() => monthStats(entries, perDay), [entries, perDay]);
  const undated = useMemo(() => undatedCount(entries), [entries]);
  const [picked, setPicked] = useState<string | null>(null);
  // Opens on the latest month with a week of entries: right after a page is
  // added, the latest month of all may be two days old and say next to nothing.
  const opened = useMemo(() => defaultMonth(stats), [stats]);
  const month = picked && stats.some((s) => s.month === picked) ? picked : opened;

  // Generated sample data: the bundled history ("seed"), and a page whose
  // reading is recorded as a stored sample reading.
  const samplePages = useMemo(() => {
    const ids = new Set<string>();
    for (const p of Array.isArray(pages) ? pages : []) if (p && typeof p.model === "string" && /\bsample\b/i.test(p.model)) ids.add(p.id);
    return ids;
  }, [pages]);

  const report = useMemo(() => {
    if (!plant || !month) return null;
    const isGenerated = (e: LogEntry) => e.pageId === "seed" || (typeof e.pageId === "string" && samplePages.has(e.pageId));
    return buildReport(plant, entries, month, { isGenerated, strayIds: strayIdsFrom(checks?.flags), suspect: suspectValuesFrom(checks?.flags) });
  }, [plant, entries, month, samplePages, checks]);

  // The checks are the ones run on the whole log (the same flags as the Flags
  // screen); the report lists those that touch this month. Run on one month
  // alone they would miss everything at a month edge.
  const flags = useMemo(() => (checks && month ? flagsForMonth(checks.flags, entries, month) : []), [checks, entries, month]);
  const within = useMemo(() => limitBreakdown(plant, report?.rows ?? []), [plant, report]);

  if (!ready) return null;
  if (!plant || !month || !report) {
    return (
      <div className="card">
        <h2>No report yet</h2>
        <p style={{ color: "var(--ink-2)", margin: "4px 0 14px" }}>
          The monthly report is built from saved log entries.
          {plant && undated > 0 &&
            ` ${undated} saved ${undated === 1 ? "entry has" : "entries have"} no readable date and cannot be placed in a month; correct the date in the Log.`}
        </p>
        <Link className="btn primary" href="/capture">Add a logbook page</Link>
      </div>
    );
  }

  const daily = report.perDay === 1;
  const entryWord = daily ? "Entries" : "Shifts";
  const exceed = flags.filter((f) => f.category === "compliance");
  const quality = flags.filter((f) => f.category !== "compliance");
  const notes = reportNotes(report);
  const missing = Math.max(0, report.expected - report.recorded);
  const outsideTotal = report.summaries.reduce((n, s) => n + (s.outside ?? 0), 0);

  // The printed report must say on its face how much of it is generated data:
  // all of it, some of it, or none.
  const total = report.rows.length;
  const generated = report.generated;
  const allGenerated = total > 0 && generated === total;
  const mixed = generated > 0 && !allGenerated;
  const samplePlant = demoKindOf(plant) !== null;

  const anyLimit = report.summaries.some((s) => s.limit !== null);
  const anyTotal = report.summaries.some((s) => s.total !== null);
  const anyColumnTotal = report.columns.some((c) => c.hasTotal && report.totals[c.id] != null);
  const anyPartial = report.daily.some((d) => d.partial.length > 0);
  const anySetAside = report.daily.some((d) => d.setAside.length > 0);
  const converted = report.summaries.some((s) => CONVERTED.includes(s.key));
  const totalOf = (k: ParamKey) => report.summaries.find((s) => s.key === k)?.total ?? null;
  const sewage = plant.kind === "ETP" ? "Effluent" : "Sewage";
  // A capacity that was never filled in is left out, not printed as "NaN KLD".
  const capacity = typeof plant.capacityKld === "number" && Number.isFinite(plant.capacityKld) && plant.capacityKld > 0 ? `${num(plant.capacityKld)} KLD` : "";
  const from = (v: { source: "meter" | "entries" }) => (v.source === "meter" ? "from meter readings" : `sum of the ${daily ? "daily" : "shift"} entries`);

  // Key figures. Only those the register actually has are listed.
  const figures: { label: string; value: string; src?: string }[] = [];
  if (report.inflow) figures.push({ label: `${sewage} received`, value: `${num(report.inflow.value)} m³`, src: from(report.inflow) });
  if (report.outflow) figures.push({ label: "Treated water discharged / reused", value: `${num(report.outflow.value)} m³`, src: from(report.outflow) });
  if (report.energyUsed !== null) figures.push({ label: "Energy used", value: `${num(report.energyUsed)} kWh`, src: "from meter readings" });
  if (totalOf("runHours") !== null) figures.push({ label: "Plant run hours", value: `${num(totalOf("runHours"), 1)} h` });
  for (const k of DOSED) {
    if (totalOf(k) !== null) figures.push({ label: PARAMS[k].label, value: `${num(totalOf(k), 2)} kg` });
  }
  if (totalOf("sludgeKg") !== null) figures.push({ label: "Sludge removed", value: `${num(totalOf("sludgeKg"), 1)} kg` });

  const tableCols = report.columns.length + 2;
  const density = tableCols > 19 ? styles.veryDense : tableCols > 14 ? styles.dense : "";

  let section = 0;
  const heading = (title: string) => <h2>{++section}. {title}</h2>;

  // A month with entries on only a few days is not a month's report yet.
  const latest = stats[0]?.month ?? month;
  const partial = report.daysRecorded < PARTIAL_MONTH_DAYS && report.daysInMonth > 0;
  const partialLine = partial
    ? `Partial month: entries on ${report.daysRecorded} of ${report.daysInMonth} days${month === latest ? " so far" : ""}.`
    : "";
  const fuller = opened && opened !== month && (stats.find((s) => s.month === opened)?.days ?? 0) >= PARTIAL_MONTH_DAYS ? opened : null;
  const latestDays = stats[0]?.days ?? 0;

  const shareText = encode(
    [
      `${String(plant.name ?? "").slice(0, 80)} – ${monthLabel(month)}`,
      partialLine,
      `${entryWord} recorded: ${report.recorded}/${report.expected}`,
      report.inflow ? `Received: ${num(report.inflow.value)} m³` : "",
      report.outflow ? `Treated: ${num(report.outflow.value)} m³` : "",
      report.energyUsed !== null ? `Energy used: ${num(report.energyUsed)} kWh` : "",
      // Counts for each parameter, lowest first: a pooled percentage hides the weak one.
      within.rate !== null ? `Outlet readings within limits: ${within.inside} of ${within.judged} (${limitBreakdownText(within)})` : "",
      checks ? `Limit exceedances: ${exceed.length} · other items to verify: ${quality.length}` : "Checks could not be run on this record",
      allGenerated ? "(generated sample data, not a real plant)" : mixed ? `(${generated} of ${total} entries are generated sample data)` : "",
      "(JalLog)",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return (
    <div className="stack">
      <div className="page-head no-print" style={{ marginBottom: 0 }}>
        <div>
          {/* The sheet below carries the page's one h1. */}
          <h2 className="h1">Monthly report</h2>
          <p>Built from the saved log. Print it, or save it as a PDF from the print dialog.</p>
        </div>
        <div className={styles.controls}>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            Month
            <select value={month} onChange={(e) => setPicked(e.target.value)}>
              {stats.map((s) => <option key={s.month} value={s.month}>{monthLabel(s.month)} ({s.entries})</option>)}
            </select>
          </label>
          <a className="btn" href={`https://wa.me/?text=${shareText}`} target="_blank" rel="noreferrer">Share summary on WhatsApp</a>
          <button className="btn primary" onClick={() => window.print()}>Print / save PDF</button>
        </div>
      </div>

      {picked === null && month !== latest && (
        <div className="notice no-print">
          {monthLabel(latest)} has entries on only {latestDays} {latestDays === 1 ? "day" : "days"} so far, so the report opens on {monthLabel(month)}.{" "}
          <button type="button" className="linkish" onClick={() => setPicked(latest)}>Show {monthLabel(latest)}</button>
        </div>
      )}

      {undated > 0 && (
        <div className="notice warn no-print">
          {undated} saved {undated === 1 ? "entry has" : "entries have"} no readable date, so {undated === 1 ? "it is" : "they are"} not in any month&apos;s report. Correct the date in the Log.
        </div>
      )}

      <article className={`report ${styles.sheet}`}>
        <h1>{sewage} Treatment Plant – Monthly Operation Report</h1>
        <p style={{ color: "var(--ink-2)" }}>
          {monthLabel(month)}
          {report.firstDate && report.lastDate &&
            ` · ${report.firstDate === report.lastDate ? formatDate(report.firstDate) : `${formatDate(report.firstDate)} to ${formatDate(report.lastDate)}`}`}
        </p>
        {partial && (
          <p className={styles.partial}>
            {partialLine}
            {fuller && (
              <>
                {" "}
                <button type="button" className="linkish no-print" onClick={() => setPicked(fuller)}>Show {monthLabel(fuller)}</button>
              </>
            )}
          </p>
        )}
        {allGenerated ? (
          <p className={styles.sample}>Generated sample data. This report does not describe a real plant.</p>
        ) : mixed ? (
          <p className={styles.sample}>
            {generated} of the {total} entries in this month are generated sample data; the other {total - generated} {total - generated === 1 ? "was" : "were"} saved on this device.
            The figures below mix the two, so they do not describe one real plant.
          </p>
        ) : samplePlant ? (
          <p className={styles.sample}>
            The plant details on this report (name, capacity, limits) belong to JalLog&apos;s sample plant. The entries in this month were saved on this device.
          </p>
        ) : null}
        <div className={`meta ${styles.figures}`}>
          <div><b>Plant</b>{plant.name || "–"}</div>
          <div><b>Location</b>{plant.location || "–"}</div>
          <div><b>Capacity and process</b>{[capacity, plant.technology].filter(Boolean).join(" · ") || "–"}</div>
          <div><b>Operated by</b>{plant.operatorCompany || "–"}</div>
          <div><b>Consent no.</b>{plant.consentNo || "–"}</div>
          <div><b>{daily ? "Daily entries" : "Shift entries"}</b>{report.recorded} recorded of {report.expected} expected</div>
          {figures.map((f) => (
            <div key={f.label}>
              <b>{f.label}</b>
              {f.value}
              {f.src && <span className={styles.src}>{f.src}</span>}
            </div>
          ))}
        </div>

        {report.summaries.length > 0 && (
          <>
            {heading("Parameter summary")}
            <div className={`table-wrap ${styles.wrap}`}>
              <table className={`data ${styles.tbl}`}>
                <thead>
                  <tr>
                    <th className="l">Parameter</th><th>Readings</th><th>Min</th><th>Average</th><th>Max</th>
                    {anyTotal && <th>Month total</th>}
                    {anyLimit && <th>Consent limit</th>}
                    {anyLimit && <th>Outside limit</th>}
                  </tr>
                </thead>
                <tbody>
                  {report.summaries.map((s) => {
                    const d = PARAMS[s.key].decimals;
                    return (
                      <tr key={s.key}>
                        <td className="l">{withUnit(s.key)}</td>
                        <td>{s.n}</td>
                        <td>{num(s.min, d)}</td>
                        <td>{num(s.mean, d)}</td>
                        <td>{num(s.max, d)}</td>
                        {anyTotal && <td>{num(s.total, d)}</td>}
                        {anyLimit && <td>{limitText(s.limit)}</td>}
                        {/* "3 of 15": the count alone does not say how often the parameter was tested. */}
                        {anyLimit && <td className={s.outside ? "bad" : ""}>{s.outside === null ? "–" : `${s.outside} of ${s.judged}`}</td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {report.meters.length > 0 && (
          <>
            {heading("Meter readings")}
            <div className={`table-wrap ${styles.wrap}`}>
              <table className={`data ${styles.tbl}`}>
                <thead>
                  <tr>
                    <th className="l">Meter</th><th>Readings</th><th>First reading</th><th>Last reading</th><th>Counted increase</th><th className="l">Counted from – to</th>
                  </tr>
                </thead>
                <tbody>
                  {report.meters.map((m) => (
                    <tr key={m.key}>
                      <td className="l">{withUnit(m.key)}</td>
                      <td>{m.readings}</td>
                      <td>{num(m.first, PARAMS[m.key].decimals)}</td>
                      <td>{num(m.last, PARAMS[m.key].decimals)}</td>
                      <td>{num(m.total, PARAMS[m.key].decimals)}</td>
                      <td className="l">{m.from && m.to ? `${shortDate(m.from)} – ${shortDate(m.to)}` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {report.daily.length > 0 && (
          <>
            {heading("Daily record")}
            <div className={`table-wrap ${styles.wrap}`}>
              <table className={`data ${styles.tbl} ${density}`}>
                <thead>
                  <tr>
                    <th className="l">Date</th>
                    <th>{entryWord}</th>
                    {report.columns.map((c) => (
                      <th key={c.id}>{c.label}{c.sub && <small>{c.sub}</small>}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.daily.map((d) => (
                    <tr key={d.date}>
                      <td className="l">{formatDate(d.date)}</td>
                      <td className={d.recorded < d.expected ? "warn" : ""}>{d.recorded}/{d.expected}</td>
                      {d.entries === 0 && report.columns.length > 0 ? (
                        <td className={styles.gapDay} colSpan={report.columns.length}>No entry in the register</td>
                      ) : (
                        report.columns.map((c) => (
                          <td key={c.id} className={d.outside.includes(c.id) ? "bad" : d.partial.includes(c.id) ? "warn" : ""}>
                            {num(d.cells[c.id], c.decimals)}
                            {d.setAside.includes(c.id) && <span title="Flagged as out of scale; left out of the month's figures">*</span>}
                          </td>
                        ))
                      )}
                    </tr>
                  ))}
                  {anyColumnTotal && (
                    <tr className={styles.total}>
                      <td className="l">Month total</td>
                      <td>{report.recorded}/{report.expected}</td>
                      {report.columns.map((c) => (
                        <td key={c.id}>{c.hasTotal ? num(report.totals[c.id], c.decimals) : ""}</td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {anyLimit && (
              <p className={styles.caption}>
                {report.perDay > 1
                  ? "A red cell means at least one reading that day was outside its consent limit, even where the day's average is inside it."
                  : "A red cell means the reading was outside its consent limit."}
              </p>
            )}
            {anySetAside && (
              <p className={styles.caption}>
                * A figure the checks flagged as far out of scale (see the record-keeping observations). It is shown as written and left out of the month&apos;s totals, averages and maxima.
              </p>
            )}
            {anyPartial && (
              <p className={styles.caption}>
                An amber figure is a day&apos;s total made from fewer than {report.perDay} shift entries, so it is lower than the whole day&apos;s total.
              </p>
            )}
          </>
        )}

        {heading("Readings outside consent limits")}
        {!checks ? (
          <p>The checks could not be run on this record, so this section is not filled in. That does not mean nothing was found.</p>
        ) : !anyLimit ? (
          <p>None of the columns in this month&apos;s register has a consent limit set, so there was nothing to compare.</p>
        ) : exceed.length === 0 ? (
          outsideTotal > 0
            ? <p>{outsideTotal} {outsideTotal === 1 ? "reading is" : "readings are"} outside {outsideTotal === 1 ? "its" : "their"} limit; see the parameter summary and the shaded cells of the daily record.</p>
            : <p>None recorded this month.</p>
        ) : (
          <ul className={styles.list}>
            {exceed.map((f) => <li key={f.id}><b>{f.title}.</b> {f.detail}</li>)}
          </ul>
        )}

        {heading("Record-keeping observations")}
        {!checks ? (
          <p>The checks could not be run on this record, so this section is not filled in. That does not mean nothing was found.</p>
        ) : quality.length === 0 && missing === 0 ? (
          <p>No gaps or irregular readings found in this month&apos;s register.</p>
        ) : (
          <>
            <p className={styles.caption} style={{ marginTop: 0, marginBottom: 6 }}>
              These are points to verify against the register and the instruments, not findings against any person.
              They come from checks run on the whole log, so one may also mention entries of another month.
            </p>
            <ul className={styles.list}>
              {/* A gap that began in the month before is flagged there; this month still says it has one. */}
              {missing > 0 && !quality.some((f) => f.ruleId === "missing") && (
                <li>
                  <b>{daily ? "Days with no entry" : "Shifts with no entry"}</b> (completeness). {missing} of the {report.expected} entries expected
                  this month {missing === 1 ? "is" : "are"} not in the saved register; the daily record shows which days.
                </li>
              )}
              {quality.map((f) => (
                <li key={f.id}><b>{f.title}</b> ({(CATEGORY_LABEL[f.category] ?? "To verify").toLowerCase()}). {f.detail}</li>
              ))}
            </ul>
          </>
        )}

        {report.remarks.length > 0 && (
          <>
            {heading("Operator remarks from the register")}
            <ul className={styles.list}>
              {report.remarks.map((r) => (
                <li key={r.id}>{formatDate(r.date)}{r.shift ? `, shift ${r.shift}` : ""}: {r.text.length > 600 ? `${r.text.slice(0, 600)}…` : r.text}</li>
              ))}
            </ul>
          </>
        )}

        {notes.length > 0 && (
          <>
            {heading("How the figures were worked out")}
            <ul className={styles.notes}>
              {notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </>
        )}

        <div className={styles.signRow}>
          <div>Plant operator</div>
          <div>Supervisor / O&amp;M in-charge</div>
        </div>
        <p className={styles.closing}>
          {allGenerated ? (
            "Prepared with JalLog from its generated sample data. No figure in it was measured at a real plant."
          ) : (
            <>
              Prepared with JalLog from the saved register entries.
              {mixed && ` ${generated} of the ${total} entries are generated sample data, not readings from a plant.`}
              {" "}Values read from a photographed page were shown to a person for checking before they were saved
              {report.corrected > 0
                ? `; a person changed ${report.corrected} of them, at that step or later in the Log.`
                : "."}
              {" "}
              {converted
                ? "Figures are as written in the register, apart from unit conversions (grams to kilograms, start and close times to hours)."
                : "Figures are as written in the register."}
              {" "}They have not been independently tested or compared with the instruments.
            </>
          )}
        </p>
      </article>
    </div>
  );
}
