"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FlagList } from "@/components/FlagList";
import { Confirm } from "@/components/TopBar";
import { runChecks } from "@/lib/checks";
import { PRIVACY_COPY, demoState, useStore } from "@/lib/store";
import type { DemoKind } from "@/lib/store";
import type { Flag } from "@/lib/types";

const STEPS = [
  ["Photograph the register", "One photo of the page, taken on a phone. The operator keeps writing in the same paper register as before."],
  ["Check what was read", "Every cell is shown with the photo pinned above the table. Anything the reader was unsure of is highlighted and has to be confirmed, and nothing is saved until a person presses Save."],
  ["See what needs a look", "Readings over the consent limit, missing entries, and readings that repeat or cannot be right, each with what to go and check on site."],
  ["Print the monthly report", "A daily summary, the readings over limit and the data-quality notes, laid out for printing."],
];

const SAMPLES: { kind: DemoKind; button: string; what: string }[] = [
  {
    kind: "shift",
    button: "Open the 3-shift sample plant",
    what: "3-shift plant with lab readings: a row for every shift with pH, DO, MLSS, COD, BOD and TSS.",
  },
  {
    kind: "daily",
    button: "Open the daily-register sample plant",
    what: "Small plant with a daily register: one row a day with flow and energy meter readings, run hours, chemical dosing and sludge.",
  },
];

// One flag exactly as the rules raise it on the generated 3-shift sample
// plant: the real output of lib/checks.ts, not a mock-up. null when the
// sample or the checks are not available, and then nothing is shown.
function sampleFlag(): Flag | null {
  try {
    const demo = demoState("shift");
    if (!demo?.plant) return null;
    const flags = runChecks(demo.plant, demo.entries).flags;
    return flags.find((f) => f.category === "compliance" && f.severity === "high") ?? flags[0] ?? null;
  } catch {
    return null;
  }
}

export function Welcome() {
  const { loadDemo, entries } = useStore();
  const [missing, setMissing] = useState<DemoKind | null>(null);
  const [asking, setAsking] = useState<DemoKind | null>(null);
  const [noPhoto, setNoPhoto] = useState(false);
  const example = useMemo(() => sampleFlag(), []);
  // Entries with no plant: a damaged record. A sample plant would replace them.
  const stray = Array.isArray(entries) ? entries.length : 0;

  const open = (kind: DemoKind) => {
    setAsking(null);
    setMissing(loadDemo(kind) ? null : kind);
  };

  return (
    <div className="stack">
      <div className="card" style={{ padding: 24 }}>
        <div className="hero">
          <div>
            <h1 style={{ fontSize: 26, maxWidth: "24ch" }}>A paper plant logbook, read from a photo and checked.</h1>
            <p style={{ color: "var(--ink-2)", marginTop: 10, maxWidth: "64ch" }}>
              JalLog turns a photo of an STP or ETP register page into records. A person checks what was read against the
              photo, then fixed rules compare every reading with the plant&apos;s consent limits and point out gaps and
              repeated entries. It works with three-shift lab sheets and with one-row-a-day meter and dosing registers.
            </p>
            {example && (
              <div className="example">
                <p className="small" style={{ color: "var(--ink-2)", marginBottom: 8 }}>
                  What a flag looks like. This one is raised by the rules on the generated 3-shift sample plant:
                </p>
                <FlagList flags={[{ ...example, entryIds: [] }]} />
              </div>
            )}
          </div>
          {!noPhoto && (
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/samples/page-1.jpg" alt="A handwritten three-shift STP logbook page with dates, shifts and readings in a ruled table" width={1600} height={1200} onError={() => setNoPhoto(true)} />
              <figcaption>A generated sample page, not a real plant&apos;s record. It is one of the pages you can try on the Capture screen.</figcaption>
            </figure>
          )}
        </div>

        {asking ? (
          <div style={{ marginTop: 18 }}>
            <Confirm
              text={`${stray} stored ${stray === 1 ? "entry has" : "entries have"} no plant and will be replaced by the sample plant. Download the CSV from the Log screen first if you need ${stray === 1 ? "it" : "them"}.`}
              no="Cancel" yes="Replace with the sample plant" danger
              onNo={() => setAsking(null)} onYes={() => open(asking)}
            />
          </div>
        ) : (
          <div className="choices">
            {SAMPLES.map((s) => (
              <div className="choice" key={s.kind}>
                <button
                  className={`btn ${s.kind === "shift" ? "primary" : ""}`}
                  onClick={() => (stray > 0 ? setAsking(s.kind) : open(s.kind))}
                >
                  {s.button}
                </button>
                <p className="small">{s.what}</p>
              </div>
            ))}
            <div className="choice">
              <Link className="btn" href="/plant">Set up my plant</Link>
              <p className="small">Enter your own plant&apos;s details and consent limits, then add pages from its register.</p>
            </div>
          </div>
        )}

        {missing && (
          <p className="notice bad" role="alert" style={{ marginTop: 12 }}>
            That sample plant is not available in this build. The other one, and your own plant, still work.
          </p>
        )}
        <p className="small" style={{ marginTop: 14, maxWidth: "80ch", color: "var(--ink-2)" }}>
          Both sample plants hold generated readings, not a real plant&apos;s data, with known problems written into them so
          you can see what the checks find. {PRIVACY_COPY}
        </p>
      </div>
      <div className="grid two">
        {STEPS.map(([title, body], i) => (
          <div className="card" key={title}>
            <div className="row" style={{ alignItems: "baseline" }}>
              <span className="tag">{i + 1}</span>
              <h2>{title}</h2>
            </div>
            <p style={{ color: "var(--ink-2)", marginTop: 6 }}>{body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
