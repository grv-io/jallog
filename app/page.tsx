"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FlagList } from "@/components/FlagList";
import { TrendChart } from "@/components/TrendChart";
import { Welcome } from "@/components/Welcome";
import { PARAMS } from "@/lib/params";
import {
  averageDailyVolume, coverage, entriesPerDay, isValidDate, limitBreakdown, limitBreakdownText, limitFor, mergeSlots, shortDate,
  strayIdsFrom, suspectValuesFrom, trendSeries, undatedCount,
} from "@/lib/report";
import { demoKindOf, demoState, formatDate, useStore } from "@/lib/store";
import type { DemoKind } from "@/lib/store";
import { PARAM_KEYS } from "@/lib/types";
import type { ParamKey } from "@/lib/types";

// Lab-style shift sheets fill the first group, daily meter-and-dosing
// registers the second. A chart appears only when its column has data.
const CHART_ORDER: ParamKey[] = [
  "tssOutlet", "codOutlet", "bodOutlet", "phOutlet", "doAeration", "mlss", "outletFlow", "residualChlorine",
  "inletTotaliser", "outletTotaliser", "runHours", "energyKwh", "limeKg", "alumKg", "chlorineKg", "sludgeKg",
];

// A cumulative meter is charted as what it gained between readings, so the
// chart is named after that quantity, not after the meter.
const INCREASE_TITLE: Partial<Record<ParamKey, string>> = {
  inletTotaliser: "Inlet volume, from the meter",
  outletTotaliser: "Outlet volume, from the meter",
  energyKwh: "Energy used",
};

// The coverage strip shows the latest days only, so a record of several years
// does not fill the screen.
const COVERAGE_DAYS = 180;

const SAMPLE_NAME: Record<DemoKind, string> = { shift: "3-shift", daily: "daily-register" };

const grouped = (n: number, maxDecimals = 0) => {
  try {
    return n.toLocaleString("en-IN", { maximumFractionDigits: maxDecimals });
  } catch {
    return String(Number(n.toFixed(maxDecimals)));
  }
};
const plural = (n: number, word: string, decimals = 0) => `${grouped(n, decimals)} ${word}${n === 1 ? "" : "s"}`;

export default function Overview() {
  const { ready, plant, entries, checks, loadDemo } = useStore();
  const perDay = entriesPerDay(plant);
  const daily = perDay === 1;
  // Switching to the other sample plant replaces what is stored; asked first.
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);

  // One row per date and shift: a page saved twice, or the two facing pages of
  // a daily register, must not show up as double readings in the trends.
  const log = useMemo(() => mergeSlots(entries, perDay), [entries, perDay]);
  const rows = log.rows;
  // An entry with no readable date has no place on a time axis. The notice
  // below says such entries are left out, so the trends leave them out too.
  const dated = useMemo(() => rows.filter((e) => isValidDate(e.date)), [rows]);
  // Entries the date rule set aside (a mistyped year) are not the start or the
  // end of the record; the strip follows the checks on which ones those are.
  const strays = useMemo(() => strayIdsFrom(checks?.flags), [checks]);
  const cov = useMemo(() => coverage(rows, perDay, COVERAGE_DAYS, strays), [rows, perDay, strays]);
  const undated = useMemo(() => undatedCount(entries), [entries]);
  const kind = plant?.kind;

  const charts = useMemo(
    () => CHART_ORDER.map((k) => ({ k, series: trendSeries(dated, k, { kind, perDay }) })).filter((c) => c.series.points.length > 0),
    [dated, kind, perDay],
  );

  // Readings against the consent limits, parameter by parameter. Built from
  // the same rows and the same rules as the monthly report's summary.
  const within = useMemo(() => limitBreakdown(plant, rows), [plant, rows]);

  // A meter rise the checks flagged as far too large (a slipped digit) is not
  // counted into the average volume, as in the monthly report.
  const suspect = useMemo(() => suspectValuesFrom(checks?.flags), [checks]);

  // A register with no lab columns has no "within limits" figure. What it does
  // have is the meter: show the average daily volume instead of an empty tile.
  const volume = useMemo(() => {
    for (const k of ["outletTotaliser", "inletTotaliser"] as const) {
      const v = averageDailyVolume(dated, k, perDay, suspect);
      if (v) return { k, ...v };
    }
    return null;
  }, [dated, perDay, suspect]);

  const flaggedByParam = useMemo(() => {
    // Flags name saved entries; a chart point is a row that may stand for
    // several of them.
    const rowOf = new Map<string, string>();
    for (const r of rows) for (const id of r.sourceIds) rowOf.set(id, r.id);
    const m = new Map<ParamKey, Set<string>>();
    for (const f of checks?.flags ?? []) {
      // Pattern-level flags (digit preference, BOD frequency...) cover dozens of
      // readings; marking each one would bury the trend.
      if (!f.param || !Array.isArray(f.entryIds) || f.entryIds.length > 10) continue;
      const s = m.get(f.param) ?? new Set<string>();
      f.entryIds.forEach((id) => s.add(rowOf.get(id) ?? id));
      m.set(f.param, s);
    }
    return m;
  }, [checks, rows]);

  if (!ready) return null;
  if (!plant) return <Welcome />;

  const flags = checks?.flags ?? [];
  const high = flags.filter((f) => f.severity === "high").length;
  const medium = flags.filter((f) => f.severity === "medium").length;
  // The latest entry of the record itself: an entry dated far from everything
  // else (a mistyped year) is a date to check, not the latest reading.
  const last =
    [...dated].reverse().find((e) => cov.lastDate !== null && e.date <= cov.lastDate) ?? dated[dated.length - 1] ?? rows[rows.length - 1];
  // "Recorded X of Y" is the count the missing-entries rule made, so this tile
  // and the Flags screen can never disagree. coverage() applies the same rules
  // and stands in only when the checks could not be run.
  const recorded = checks ? checks.recordedShifts : cov.recorded;
  const expected = checks ? checks.expectedShifts : cov.expected;
  const gaps = Math.max(0, expected - recorded);
  const slotWord = daily ? "day" : "shift";
  const limited = PARAM_KEYS.filter((k) => limitFor(plant, k) !== null).map((k) => PARAMS[k].short);
  const anyNeutral = cov.days.some((d) => d.slots.some((ok, i) => !ok && !d.expected[i]));

  const withYear: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const sameYear = cov.firstDate?.slice(0, 4) === cov.lastDate?.slice(0, 4);
  // A capacity that was never filled in (or was saved as text) is left out, not shown as "NaN KLD".
  const capacity = typeof plant.capacityKld === "number" && Number.isFinite(plant.capacityKld) && plant.capacityKld > 0 ? `${grouped(plant.capacityKld, 2)} KLD` : "";
  const where = [`${capacity} ${plant.technology ?? ""} ${plant.kind ?? ""}`.replace(/\s+/g, " ").trim(), plant.location].filter(Boolean).join(" · ");

  const demo = demoKindOf(plant);
  const other: DemoKind | null = demo === null ? null : demo === "shift" ? "daily" : "shift";
  // Untouched since it was loaded: the stored entries are still the generated
  // ones, so switching loses nothing and needs no question.
  const pristine = demo !== null && entries === demoState(demo)?.entries;
  const switchSample = () => {
    if (!other) return;
    setSwitching(false);
    setSwitchFailed(!loadDemo(other));
  };

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        {/* A plant name typed without spaces must wrap, not push the page sideways. */}
        <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          <h1>{plant.name}</h1>
          <p style={{ maxWidth: "80ch" }}>
            {where}
            {cov.firstDate && cov.lastDate &&
              (cov.firstDate === cov.lastDate
                ? ` · one day on record, ${formatDate(cov.lastDate, withYear)}`
                : ` · records ${formatDate(cov.firstDate, sameYear ? undefined : withYear)} to ${formatDate(cov.lastDate, withYear)}`)}
          </p>
          {/* The sample plants must never be mistaken for a real plant's record. */}
          {demo !== null && other !== null && (
            <p className="row" style={{ gap: 8 }}>
              <span className="tag">Generated sample data, not a real plant</span>
              {/* The welcome screen is gone once a plant is open; this is the way to the other sample. */}
              {!switching && (
                <button type="button" className="linkish small" onClick={() => (pristine ? switchSample() : setSwitching(true))}>
                  Switch to the {SAMPLE_NAME[other]} sample
                </button>
              )}
            </p>
          )}
          {switching && other !== null && (
            <div className="notice warn" role="group" aria-label="Replace this plant with the other sample plant" style={{ marginTop: 6, maxWidth: "70ch" }}>
              Replace {plant.name} and its {grouped(entries.length)} {entries.length === 1 ? "entry" : "entries"} with the {SAMPLE_NAME[other]} sample plant?
              Anything you added or changed here is deleted from this browser. Download the CSV from the Log screen first if you need it.
              <span className="row" style={{ marginTop: 8 }}>
                <button type="button" className="btn sm" onClick={() => setSwitching(false)}>Cancel</button>
                <button type="button" className="btn sm danger" onClick={switchSample}>Replace with the sample plant</button>
              </span>
            </div>
          )}
          {switchFailed && (
            <p className="notice bad" role="alert" style={{ marginTop: 6 }}>That sample plant is not available in this build.</p>
          )}
        </div>
        <Link className="btn primary" href="/capture">Add a logbook page</Link>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <h2>No readings yet</h2>
          <p style={{ color: "var(--ink-2)", marginTop: 4 }}>Photograph a page of the register to start the record.</p>
        </div>
      ) : (
        <>
          {checks === null && (
            <div className="notice warn">
              The checks could not be run on this record, so flags and the within-limits figure are not shown. The saved readings are not affected; they are all in the Log.
            </div>
          )}
          {undated > 0 && (
            <div className="notice warn">
              {undated} {undated === 1 ? "entry has" : "entries have"} no readable date, so {undated === 1 ? "it is" : "they are"} left out of the coverage strip, the trends and the monthly report. Correct the date in the Log.
            </div>
          )}

          <div className="grid kpis">
            <div className="card tile">
              <div className="label">{daily ? "Entries recorded" : "Shifts recorded"}</div>
              <div className="value">
                {grouped(recorded)}
                <small> of {grouped(expected)}</small>
              </div>
              <div className="hint">
                {expected === 0
                  ? "No dated entries yet"
                  : gaps > 0
                    ? `${grouped(gaps)} ${slotWord}${gaps === 1 ? "" : "s"} with no entry`
                    : "No gaps in the register"}
              </div>
            </div>
            {within.rate === null && volume ? (
              <div className="card tile">
                <div className="label">Average {volume.k === "outletTotaliser" ? "outlet" : "inlet"} volume per day</div>
                <div className="value">
                  {/* One decimal below 100: at a 10 KLD plant, 7.5 rounded to 7 is a 7% step. */}
                  {grouped(volume.perDay, volume.perDay < 100 ? 1 : 0)}
                  <small> m³</small>
                </div>
                <div className="hint">
                  {grouped(volume.total)} m³ on the meter over {plural(volume.days, "day", 1)}{capacity && ` · design capacity ${capacity}`}
                </div>
              </div>
            ) : (
              <div className="card tile">
                <div className="label">Outlet readings within limits</div>
                <div className="value">
                  {checks === null || within.rate === null ? "–" : `${(within.rate * 100).toFixed(1)}%`}
                  {checks !== null && within.rate !== null && (
                    <small> {grouped(within.inside)} of {grouped(within.judged)}</small>
                  )}
                </div>
                {/* One pooled figure hides the weak parameter (pH is read every shift
                    and is rarely outside), so each parameter is listed, lowest first. */}
                <div className="hint">
                  {limited.length === 0
                    ? "No consent limits are set for this plant"
                    : within.rate === null
                      ? `No readings yet for ${limited.join(", ")}`
                      : checks === null
                        ? "Checks did not run"
                        : `${within.params.length > 1 ? "Lowest first: " : ""}${limitBreakdownText(within, " · ")}`}
                </div>
              </div>
            )}
            <div className="card tile">
              <div className="label">To verify</div>
              <div className="value">
                {checks ? high : "–"}
                {checks && <small> high</small>}
              </div>
              <div className="hint">{checks ? `${medium} medium · ${flags.length - high - medium} low` : "Checks did not run"}</div>
            </div>
            <div className="card tile">
              <div className="label">Latest entry</div>
              <div className="value" style={{ fontSize: 22, marginTop: 6 }}>
                {formatDate(last.date)}
                {last.shift && <small> shift {last.shift}</small>}
              </div>
              <div className="hint">{last.operator ? `by ${last.operator}` : "operator not recorded"}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Needs attention</h2>
              {checks && (
                <Link href="/flags" className="small" style={{ color: "var(--accent)", fontWeight: 600 }}>
                  {flags.length === 0 ? "Flags" : flags.length === 1 ? "The 1 flag" : `All ${grouped(flags.length)} flags`}
                </Link>
              )}
            </div>
            {checks ? <FlagList flags={flags} limit={4} /> : <p className="muted">The checks did not run, so there is nothing to list here.</p>}
          </div>

          {cov.days.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Register coverage</h2>
                <span className="sub">{daily ? "one bar per entry" : "one bar per shift"}</span>
              </div>
              <div className="calendar">
                {cov.days.map((d, i) => {
                  const due = d.expected.filter(Boolean).length;
                  const got = d.slots.filter(Boolean).length;
                  return (
                    <div
                      className="day" key={d.date}
                      title={due === 0 && got === 0 ? `${formatDate(d.date)}: no entry expected` : `${formatDate(d.date)}: ${got} of ${Math.max(due, got)} recorded`}
                    >
                      <div className="dots">
                        {d.slots.map((ok, j) =>
                          // A slot nobody was due to fill (before the first entry, after the
                          // latest, inside a long break) is drawn neutral, never as a gap.
                          ok ? <i key={j} /> : d.expected[j] ? <i key={j} className="miss" /> : <i key={j} className="na" />,
                        )}
                      </div>
                      {/* The first cell and each 1st of a month name the month, so a strip
                          that runs over several months can be read. */}
                      {i === 0 || d.date.endsWith("-01") ? <b style={{ fontWeight: 600, color: "var(--ink-2)", whiteSpace: "nowrap" }}>{shortDate(d.date)}</b> : Number(d.date.slice(8))}
                    </div>
                  );
                })}
              </div>
              <div className="legend">
                <span><i style={{ width: 9, height: 12, borderRadius: 2, background: "var(--series)" }} />Entry recorded</span>
                <span><i style={{ width: 9, height: 12, borderRadius: 2, boxShadow: "inset 0 0 0 1.5px var(--critical)" }} />No entry for the {slotWord}</span>
                {anyNeutral && (
                  <span><i style={{ width: 9, height: 12, borderRadius: 2, background: "var(--hairline)" }} />No entry expected ({daily ? "a long break in the record" : "before the first entry, after the latest, or a long break"})</span>
                )}
              </div>
              {cov.truncated && (
                <p className="muted small" style={{ marginTop: 6 }}>
                  Showing the latest {cov.days.length} of {grouped(cov.totalDays)} days between the first and last entry.
                </p>
              )}
              {cov.strays > 0 && (
                <p className="muted small" style={{ marginTop: 6 }}>
                  {cov.strays} {cov.strays === 1 ? "entry is" : "entries are"} dated far from the rest of the record and {cov.strays === 1 ? "is" : "are"} not shown here. Check the date; see Flags.
                </p>
              )}
              {log.folded > 0 && (
                <p className="muted small" style={{ marginTop: 6 }}>
                  {log.folded} saved {log.folded === 1 ? "entry repeats" : "entries repeat"} a {daily ? "date" : "date and shift"} that is already in the log; each is shown once here.
                </p>
              )}
            </div>
          )}

          <div>
            <div className="card-head" style={{ margin: "6px 2px 10px", flexWrap: "wrap" }}>
              <h2>Trends</h2>
              {/* The same shapes as the chart markers: a circle for a reading outside its
                  limit, a diamond for one a check has flagged. Not told apart by colour alone. */}
              <div className="legend" style={{ marginTop: 0 }}>
                <span><i style={{ width: 9, height: 9, borderRadius: 9, background: "var(--critical)" }} />Outside limit</span>
                <span>
                  <i style={{ width: 8, height: 8, margin: "0 7px 0 2px", transform: "rotate(45deg)", background: "var(--warning)", boxShadow: "0 0 0 1.5px var(--warning-text)" }} />
                  Flagged to verify
                </span>
              </div>
            </div>
            {charts.length === 0 ? (
              <div className="card">
                <p className="muted">No readings to plot yet.</p>
              </div>
            ) : (
              <div className="grid two">
                {charts.map(({ k, series }) => {
                  const increase = series.mode === "increase";
                  const title = increase ? (INCREASE_TITLE[k] ?? PARAMS[k].label) : PARAMS[k].label;
                  const how = increase
                    ? series.per === "reading" ? "since the previous reading" : `per ${series.per}`
                    : daily ? "per entry" : "per shift";
                  return (
                    <div className="card" key={k}>
                      <div className="card-head" style={{ marginBottom: 6 }}>
                        <h3>{title}</h3>
                        <span className="sub">{PARAMS[k].unit || "pH units"} · {how}</span>
                      </div>
                      <TrendChart
                        param={k} entries={dated} limit={limitFor(plant, k)} flagged={flaggedByParam.get(k) ?? new Set()} title={title}
                        plantKind={plant.kind} perDay={perDay}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
