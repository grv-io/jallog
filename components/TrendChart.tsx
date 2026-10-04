"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PARAMS } from "@/lib/params";
import { cleanLimit, isOutside, isValidDate, nearestIndex, niceTicks, physicalMaxFor, thinForDrawing, trendSeries } from "@/lib/report";
import type { TrendPoint } from "@/lib/report";
import { formatDate } from "@/lib/store";
import type { LogEntry, ParamKey, Plant } from "@/lib/types";

interface Props {
  param: ParamKey;
  entries: LogEntry[]; // sorted
  limit?: { min?: number; max?: number } | null;
  flagged: Set<string>; // entry ids carrying a flag for this param
  // What the chart shows, for screen readers. Defaults to the parameter name.
  title?: string;
  // The plant's kind decides what counts as an impossible reading (an ETP can
  // show far more COD than an STP); entries per day tells an increase between
  // two consecutive entries from one that runs across a missing entry.
  plantKind?: Plant["kind"] | null;
  perDay?: 1 | 2 | 3;
}

const H = 168;
const M = { top: 12, right: 14, bottom: 22 };
// The table for screen readers lists this many of the latest points. The
// arrow keys reach every point.
const TABLE_ROWS = 60;

// Present for screen readers and keyboard users, invisible on screen.
const SR_ONLY: React.CSSProperties = {
  position: "absolute", width: 1, height: 1, margin: -1, padding: 0, border: 0,
  overflow: "hidden", clip: "rect(0 0 0 0)", clipPath: "inset(50%)", whiteSpace: "nowrap",
};

function axisLabel(t: number): string {
  try {
    // 25,00,00,000 does not fit beside an axis; 25Cr does. Lakhs are written
    // out, because "4L" beside a kg or m³ axis reads as four litres.
    if (Math.abs(t) >= 10000000) return new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 2 }).format(t);
    return t.toLocaleString("en-IN", { maximumFractionDigits: 4 });
  } catch {
    return String(t);
  }
}

function valueLabel(v: number, decimals: number, maxDecimals = decimals): string {
  try {
    return v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: Math.max(decimals, maxDecimals) });
  } catch {
    return v.toFixed(decimals);
  }
}

function slotLabel(e: LogEntry): string {
  return e.shift ? `shift ${e.shift}` : e.time ? String(e.time) : "";
}

// A diamond, so that "flagged to verify" differs from "outside limit" (a
// filled circle) by shape and not by colour alone.
function diamond(cx: number, cy: number, r: number): string {
  return `M${cx.toFixed(1)},${(cy - r).toFixed(1)}L${(cx + r).toFixed(1)},${cy.toFixed(1)}L${cx.toFixed(1)},${(cy + r).toFixed(1)}L${(cx - r).toFixed(1)},${cy.toFixed(1)}Z`;
}

export function TrendChart({ param, entries, limit, flagged, title, plantKind, perDay }: Props) {
  const meta = PARAMS[param];
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(480);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A value read by touch stays up after the finger lifts (see the pointer
  // handlers below), so something else has to take it down: a tap anywhere
  // outside this chart.
  const showing = hover !== null;
  useEffect(() => {
    if (!showing) return;
    const away = (ev: PointerEvent) => {
      if (ref.current && ev.target instanceof Node && !ref.current.contains(ev.target)) setHover(null);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [showing]);

  // An entry with no readable date has no place on a time axis. The overview
  // says such entries are left out, so they are left out here as well.
  const rows = useMemo(() => (Array.isArray(entries) ? entries.filter((e) => e && isValidDate(e.date)) : []), [entries]);

  // An impossible value (pH 71) would flatten the whole trend; it is reported
  // under Flags instead of being plotted. A cumulative meter is plotted as
  // what it gained since the previous reading.
  const series = useMemo(() => trendSeries(rows, param, { kind: plantKind, perDay }), [rows, param, plantKind, perDay]);
  const pts = series.points;
  const increase = series.mode === "increase";
  const name = title ?? meta.label;
  const unit = meta.unit;
  // A consent limit applies to a reading, not to a meter's increase.
  const lim = increase ? null : cleanLimit(limit);
  // "day" or "shift" when the meter is read at every entry; otherwise the
  // increase is simply since the last reading.
  const per = series.per === "reading" ? "reading interval" : series.per;
  const capCount = series.aboveCap.length;
  const capOutside = lim ? series.aboveCap.filter((a) => isOutside(lim, a.v)).length : 0;

  const notes = (
    <>
      {series.skipped > 0 && (
        <p className="muted small" style={{ marginTop: 4 }}>
          {series.skipped} physically impossible value{series.skipped > 1 ? "s" : ""} not plotted; see Flags.
        </p>
      )}
      {capCount > 0 && (
        <p className="muted small" style={{ marginTop: 4 }}>
          {capCount} value{capCount > 1 ? "s" : ""} above {axisLabel(physicalMaxFor(plantKind, param))}{unit ? ` ${unit}` : ""} {capCount > 1 ? "are" : "is"} not plotted:
          a slip of the pen or a very large exceedance.
          {capOutside > 0 ? ` ${capOutside === capCount ? (capCount > 1 ? "They are" : "It is") : `${capOutside} of them ${capOutside > 1 ? "are" : "is"}`} counted as outside the limit.` : ""} See Flags.
        </p>
      )}
      {series.spans > 0 && (
        <p className="muted small" style={{ marginTop: 4 }}>
          {series.spans} point{series.spans > 1 ? "s" : ""} (hollow) {series.spans > 1 ? "are averages" : "is an average"} over more than one {per},
          because the meter readings in between are missing or were set aside.
        </p>
      )}
      {series.falls > 0 && (
        <p className="muted small" style={{ marginTop: 4 }}>
          The meter reading went down {series.falls === 1 ? "once" : `${series.falls} times`}; nothing is plotted for {series.falls === 1 ? "that step" : "those steps"}. See Flags.
        </p>
      )}
      {series.outOfSequence > 0 && (
        <p className="muted small" style={{ marginTop: 4 }}>
          {series.outOfSequence === 1
            ? "1 meter reading was lower than the one before it or higher than the one after it, so it is set aside and the increase is taken across it."
            : `${series.outOfSequence} meter readings were lower than the one before or higher than the one after, so they are set aside and the increase is taken across them.`}{" "}
          See Flags.
        </p>
      )}
    </>
  );

  if (pts.length === 0) {
    return (
      <div className="chart" ref={ref}>
        <p className="muted small" style={{ padding: "28px 0" }}>
          {/* The label keeps its capitals: "outlet cod" is not how anyone writes it. */}
          {increase
            ? `Two readings of the ${meta.label.toLowerCase().replace(/ reading$/, "")} in sequence are needed before an increase can be plotted.`
            : `No ${meta.label} readings to plot yet.`}
        </p>
        {notes}
      </div>
    );
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    if (p.v < lo) lo = p.v;
    if (p.v > hi) hi = p.v;
  }
  const dataLo = lo;
  const dataHi = hi;
  if (lim?.min !== undefined) lo = Math.min(lo, lim.min);
  if (lim?.max !== undefined) hi = Math.max(hi, lim.max);
  const minStep = Math.pow(10, -meta.decimals);
  // One point, or all values equal, still needs some height to sit in.
  const pad = hi > lo ? (hi - lo) * 0.08 : Math.max(Math.abs(hi) * 0.05, minStep);
  lo = Math.max(increase ? 0 : meta.physicalMin, lo - pad);
  hi = hi + pad;
  const ticks = niceTicks(lo, hi, 4, minStep);
  const y0 = ticks[0];
  const y1 = ticks[ticks.length - 1];
  const tickText = ticks.map(axisLabel);

  // The left margin grows with the widest axis label, so large values are
  // never cut off, but never takes more than a third of the chart.
  const left = Math.min(Math.round(w / 3), Math.max(38, 12 + Math.max(...tickText.map((t) => t.length)) * 6.4));
  const iw = Math.max(10, w - left - M.right);
  const ih = H - M.top - M.bottom;
  const n = rows.length;
  const x = (i: number) => left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => M.top + ih - (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5) * ih;

  // Break the line where readings are missing so a gap is not drawn as data.
  // "Missing" is judged against the series' own rhythm: a lab value taken
  // every third day is still one line, and breaks only where the gap is well
  // beyond its usual spacing.
  const spacing = pts.slice(1).map((p, k) => p.i - pts[k].i).sort((a, b) => a - b);
  const maxGap = Math.max(3, Math.ceil((spacing[spacing.length >> 1] ?? 1) * 2.5));
  const segments: TrendPoint[][] = [];
  pts.forEach((p, k) => {
    const prev = pts[k - 1];
    if (!prev || p.i - prev.i > maxGap) segments.push([p]);
    else segments[segments.length - 1].push(p);
  });
  // With far more points than pixels, draw a few per pixel column (first,
  // lowest, highest, last). The hover below still reads every point.
  const dense = pts.length > iw * 2;
  let d = "";
  // A reading with no neighbour (sludge removed once a week) has no line to
  // belong to. It is drawn as a small dot in the line's colour, so it is not
  // mistaken for the larger red and amber status markers.
  const lone: TrendPoint[] = [];
  for (const seg of segments) {
    if (seg.length === 1) {
      lone.push(seg[0]);
      continue;
    }
    const px = seg.map((p) => x(p.i));
    const py = seg.map((p) => y(p.v));
    const keep = dense ? thinForDrawing(px, py) : seg.map((_, k) => k);
    keep.forEach((k, j) => {
      d += `${j === 0 ? "M" : "L"}${px[k].toFixed(1)},${py[k].toFixed(1)}`;
    });
  }

  const xTickCount = Math.min(5, Math.max(2, Math.floor(iw / 90)));
  const xTicks = [...new Set(Array.from({ length: xTickCount }, (_, k) => Math.round((k / (xTickCount - 1)) * (n - 1))))].filter(
    (i) => i >= 0 && i < n && rows[i],
  );

  const marked = pts.filter((p) => isOutside(lim, p.v) || flagged.has(p.entry.id));
  // The count under the chart is the limit rule's count: it includes a
  // reading too high to plot.
  const outsideCount = lim ? pts.filter((p) => isOutside(lim, p.v)).length + capOutside : 0;
  const crowded = marked.length > 400;
  const averaged = pts.filter((p) => p.span > 1);

  const xs = pts.map((p) => x(p.i));
  const hoverIndex = hover === null ? null : Math.min(Math.max(hover, 0), pts.length - 1);
  const hp = hoverIndex === null ? null : pts[hoverIndex];

  // A record that runs across a new year needs the year on its dates.
  const spansYears = String(rows[0]?.date ?? "").slice(0, 4) !== String(rows[n - 1]?.date ?? "").slice(0, 4);
  const day = (iso: string) => formatDate(iso, spansYears ? { day: "numeric", month: "short", year: "2-digit" } : undefined);

  const when = (e: LogEntry) => {
    const slot = slotLabel(e);
    return `${day(e.date)}${slot ? ` · ${slot}` : ""}`;
  };
  // A span is plotted as an average, so its value can need one more decimal
  // than the meter shows (165 kWh over two shifts is 82.5 a shift).
  const shown = (p: TrendPoint) => valueLabel(p.v, meta.decimals, p.span > 1 ? meta.decimals + 1 : meta.decimals);
  const withUnit = (text: string) => `${text}${unit ? ` ${unit}` : ""}`;
  const spanText = (p: TrendPoint) => {
    if (!increase || p.span <= 1 || p.total === null) return "";
    const count = `${valueLabel(p.span, 0, 1)} ${per}s`;
    const since = p.since && isValidDate(p.since.date) ? ` since ${when(p.since)}` : "";
    return ` · average over ${count}: ${withUnit(valueLabel(p.total, meta.decimals))}${since}`;
  };
  const describe = (p: TrendPoint) => `${when(p.entry)}${spanText(p)}`;
  const status = (p: TrendPoint) =>
    [isOutside(lim, p.v) ? "outside the limit" : "", flagged.has(p.entry.id) ? "flagged to verify" : "", p.span > 1 ? "an average over missing readings" : ""]
      .filter(Boolean)
      .join(", ");

  function onPointer(ev: React.PointerEvent<SVGSVGElement>) {
    const rect = ev.currentTarget.getBoundingClientRect();
    // The SVG can be scaled down by CSS on a very narrow screen.
    const scale = rect.width > 0 ? w / rect.width : 1;
    const k = nearestIndex(xs, (ev.clientX - rect.left) * scale);
    setHover(k < 0 ? null : k);
  }

  function onKey(ev: React.KeyboardEvent<HTMLDivElement>) {
    const last = pts.length - 1;
    const at = hoverIndex ?? last + 1; // the first key press lands on the latest reading
    const next: Record<string, number> = {
      ArrowLeft: at - 1, ArrowRight: hoverIndex === null ? last : at + 1,
      PageUp: at - 10, PageDown: hoverIndex === null ? last : at + 10, Home: 0, End: last,
    };
    if (ev.key === "Escape") return setHover(null);
    if (!(ev.key in next)) return;
    ev.preventDefault();
    setHover(Math.min(Math.max(next[ev.key], 0), last));
  }

  const first = pts[0];
  const latest = pts[pts.length - 1];
  const plural = pts.length === 1 ? "" : "s";
  const summary =
    `${name}: ${pts.length} ${increase ? `increase${plural} between meter readings` : `reading${plural}`}, ` +
    `${first.entry.date === latest.entry.date ? `on ${day(first.entry.date)}` : `${day(first.entry.date)} to ${day(latest.entry.date)}`}. ` +
    `Lowest ${withUnit(valueLabel(dataLo, meta.decimals, meta.decimals + 1))}, highest ${withUnit(valueLabel(dataHi, meta.decimals, meta.decimals + 1))}, latest ${withUnit(shown(latest))}.` +
    (series.spans > 0 ? ` ${series.spans} of them ${series.spans === 1 ? "is an average" : "are averages"} over more than one ${per}, where readings in between are missing or were set aside.` : "") +
    (lim ? ` Consent limit ${[lim.min !== undefined ? `at least ${lim.min}` : "", lim.max !== undefined ? `at most ${lim.max}` : ""].filter(Boolean).join(", ")}; ${outsideCount} outside it.` : "") +
    (capCount > 0 ? ` ${capCount} value${capCount > 1 ? "s" : ""} too high to plot.` : "") +
    " Use the left and right arrow keys to read each value.";

  const tableRows = pts.slice(-TABLE_ROWS);
  // A one-row-a-day register has no shifts or times: leave that column out.
  const hasSlot = tableRows.some((p) => slotLabel(p.entry) !== "");
  const tip = hp ? `${withUnit(shown(hp))} · ${describe(hp)}` : "";
  // Keep the tooltip inside the chart; a long one would otherwise widen the
  // page on a phone.
  const tipHalf = Math.min(w / 2, (tip.length * 6.6 + 18) / 2);

  // The limit's label sits at the right end of its line, on the side away
  // from the allowed range, unless readings run through that spot. Then it
  // takes whichever of the four corners of the line has the fewest readings
  // under it. It is also drawn after the series, with a halo, so a line or a
  // marker can never make it unreadable.
  const limitLabels = (["max", "min"] as const).flatMap((side) => {
    const lv = lim?.[side];
    if (lv === undefined) return [];
    const text = `Limit ${side === "max" ? "≤" : "≥"} ${lv}`;
    const width = text.length * 6.2 + 6;
    const above = y(lv) - 4;
    const below = y(lv) + 12;
    const spots = (side === "max" ? [above, below] : [below, above])
      // Not off the top of the chart or down among the date labels.
      .filter((ty) => ty >= M.top + 8 && ty <= M.top + ih - 2)
      .flatMap((ty) => [{ ty, atLeft: false }, { ty, atLeft: true }]);
    if (!spots.length) spots.push({ ty: Math.min(Math.max(above, M.top + 8), M.top + ih - 2), atLeft: false });
    const hits = (s: { ty: number; atLeft: boolean }) => {
      const x0 = s.atLeft ? left + 4 : w - M.right - width;
      return pts.filter((p) => x(p.i) >= x0 - 5 && x(p.i) <= x0 + width + 5 && Math.abs(y(p.v) - (s.ty - 4)) <= 11).length;
    };
    // The first spot wins a tie, so the label stays put unless moving helps.
    const best = spots.reduce((a, b) => (hits(b) < hits(a) ? b : a));
    return [{ side, lv, text, ty: best.ty, tx: best.atLeft ? left + 4 : w - M.right, anchor: best.atLeft ? ("start" as const) : ("end" as const) }];
  });

  return (
    <div className="chart" ref={ref} tabIndex={0} role="group" aria-label={`${name} trend`} onKeyDown={onKey} onBlur={() => setHover(null)}>
      <svg
        width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label={summary}
        // A sideways drag reads along the chart; an up-and-down drag still scrolls the page.
        style={{ touchAction: "pan-y" }}
        onPointerMove={onPointer}
        onPointerDown={(ev) => {
          // Focus, so that a tap elsewhere (blur) takes the value down again.
          ref.current?.focus({ preventScroll: true });
          onPointer(ev);
        }}
        // A finger lifting fires pointerleave. Clearing the value then would
        // mean it can only be read while the finger covers it.
        onPointerLeave={(ev) => {
          if (ev.pointerType !== "touch") setHover(null);
        }}
      >
        {ticks.map((t, k) => (
          <g key={t}>
            <line x1={left} x2={w - M.right} y1={y(t)} y2={y(t)} stroke={k === 0 ? "var(--axis)" : "var(--hairline)"} />
            <text x={left - 6} y={y(t) + 3.5} textAnchor="end">{tickText[k]}</text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 5} textAnchor={n <= 1 ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>
            {day(rows[i].date)}
          </text>
        ))}
        {limitLabels.map((l) => (
          <line key={l.side} x1={left} x2={w - M.right} y1={y(l.lv)} y2={y(l.lv)} stroke="var(--critical)" strokeWidth={1} />
        ))}
        <path d={d} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {lone.map((p) => (
          <circle key={`${p.i}:${p.entry.id}`} cx={x(p.i)} cy={y(p.v)} r={2.5} fill="var(--series)" />
        ))}
        {/* An average over missing readings: hollow, so it is not read as one entry's figure. */}
        {averaged.map((p) => (
          <circle key={`${p.i}:${p.entry.id}`} cx={x(p.i)} cy={y(p.v)} r={3.5} fill="var(--surface)" stroke="var(--series)" strokeWidth={1.5} />
        ))}
        {marked.map((p) =>
          isOutside(lim, p.v) ? (
            <circle
              key={`${p.i}:${p.entry.id}`} cx={x(p.i)} cy={y(p.v)} r={crowded ? 2.5 : 4}
              fill="var(--critical)" stroke={crowded ? "none" : "var(--surface)"} strokeWidth={2}
            />
          ) : (
            <path
              key={`${p.i}:${p.entry.id}`} d={diamond(x(p.i), y(p.v), crowded ? 3 : 5)}
              fill="var(--warning)" stroke="var(--warning-text)" strokeWidth={crowded ? 0.75 : 1.5} strokeLinejoin="round"
            />
          ),
        )}
        {limitLabels.map((l) => (
          <text
            key={l.side} x={l.tx} y={l.ty} textAnchor={l.anchor}
            style={{ fill: "var(--ink-2)", paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 4, strokeLinejoin: "round" }}
          >
            {l.text}
          </text>
        ))}
        {hp && (
          <g>
            <line x1={x(hp.i)} x2={x(hp.i)} y1={M.top} y2={M.top + ih} stroke="var(--axis)" />
            <circle cx={x(hp.i)} cy={y(hp.v)} r={4.5} fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="tip"
          style={{
            left: Math.min(Math.max(x(hp.i), tipHalf), w - tipHalf), top: y(hp.v),
            maxWidth: w, ...(tip.length * 6.6 + 18 > w ? { whiteSpace: "normal" as const } : {}),
          }}
        >
          <b>{shown(hp)}</b> {unit}{" "}
          <span>· {describe(hp)}</span>
        </div>
      )}
      <p style={SR_ONLY} aria-live="polite">
        {hp ? `${withUnit(shown(hp))}, ${describe(hp).replace(/ · /g, ", ")}${status(hp) ? `, ${status(hp)}` : ""}` : ""}
      </p>
      {/* A table ignores width and overflow set on itself, so the clipping box is a wrapper. */}
      <div style={SR_ONLY}>
        <table>
          <caption>
            {name}{increase ? `, increase per ${per}` : ""}
            {pts.length > tableRows.length ? ` (latest ${tableRows.length} of ${pts.length} values)` : ""}
          </caption>
          <thead>
            <tr><th scope="col">Date</th>{hasSlot && <th scope="col">Shift or time</th>}<th scope="col">Value{unit ? ` (${unit})` : ""}</th><th scope="col">Note</th></tr>
          </thead>
          <tbody>
            {tableRows.map((p) => (
              <tr key={`${p.i}:${p.entry.id}`}>
                <td>{day(p.entry.date)}</td>
                {hasSlot && <td>{slotLabel(p.entry)}</td>}
                <td>{shown(p)}</td>
                <td>{status(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes}
    </div>
  );
}
