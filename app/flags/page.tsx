"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { CATEGORY_LABEL, FlagList } from "@/components/FlagList";
import { RULES } from "@/lib/checks";
import { formatDateTime, useStore } from "@/lib/store";
import type { FlagCategory } from "@/lib/types";

const FILTERS: ("all" | FlagCategory)[] = ["all", "compliance", "integrity", "completeness", "plausibility"];

// useSearchParams needs a Suspense boundary above it for the page to build.
export default function FlagsPageView() {
  return (
    <Suspense fallback={null}>
      <FlagsPage />
    </Suspense>
  );
}

function FlagsPage() {
  const { ready, plant, entries, pages, checks } = useStore();
  const search = useSearchParams();
  // /flags?page=<id>: opened from "See all flags" after a page was saved.
  // The flags that include a row of that page are listed first.
  const pageId = (search?.get("page") ?? "").slice(0, 80);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  // The list of rules is 17 blocks long: open on a wide screen, folded on a
  // phone, where it would otherwise add six screens under the flags.
  const [rulesOpen, setRulesOpen] = useState(
    () => typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia("(min-width: 761px)").matches,
  );

  const fromPage = useMemo(() => {
    if (!pageId) return new Set<string>();
    return new Set((Array.isArray(entries) ? entries : []).filter((e) => e && e.pageId === pageId).map((e) => e.id));
  }, [entries, pageId]);

  if (!ready) return null;

  const flags = checks?.flags ?? [];
  const shown = filter === "all" ? flags : flags.filter((f) => f.category === filter);
  const touches = (ids: string[] | undefined) => (ids ?? []).some((id) => fromPage.has(id));
  const first = fromPage.size > 0 ? shown.filter((f) => touches(f.entryIds)) : [];
  const rest = fromPage.size > 0 ? shown.filter((f) => !touches(f.entryIds)) : shown;
  const page = pageId ? (Array.isArray(pages) ? pages : []).find((p) => p && p.id === pageId) : undefined;
  const pageWhen = page ? formatDateTime(page.uploadedAt) : "";

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Flags</h1>
          <p>Readings and patterns that a fixed rule picked out of the log, each with the numbers and what to go and check.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h2>What a flag is, and what it is not</h2></div>
        <div className="grid two" style={{ gap: 10 }}>
          <p className="small" style={{ color: "var(--ink-2)" }}>
            <b style={{ color: "var(--ink)" }}>It is</b> a reason to look: a reading outside the limits entered for this plant, an entry
            that is missing, or numbers that repeat or cannot be right. Each one says what to verify on site or in the lab sheets.
          </p>
          <p className="small" style={{ color: "var(--ink-2)" }}>
            <b style={{ color: "var(--ink)" }}>It is not</b> a finding against a person, and not proof that anything is wrong. A repeated
            reading can be a stuck instrument as easily as a copied entry. And no flags does not certify the plant: the rules only see
            what was written down and saved here.
          </p>
        </div>
      </div>

      {!plant && (
        <div className="card">
          <h2>No plant yet</h2>
          <p style={{ color: "var(--ink-2)", margin: "4px 0 14px" }}>Flags appear once a plant is chosen and a register page is saved.</p>
          <div className="row">
            <Link className="btn primary" href="/">Choose a plant</Link>
          </div>
        </div>
      )}

      {plant && !checks && (
        <div className="notice bad" role="alert">
          The checks could not run on this record, so no flags are shown. This is a fault in JalLog, not a clean result. The
          readings themselves are safe on the Log screen.
        </div>
      )}

      {plant && checks && (
        <>
          <div className="row" role="group" aria-label="Filter flags by type">
            {FILTERS.map((f) => {
              const n = f === "all" ? flags.length : flags.filter((x) => x.category === f).length;
              return (
                <button
                  key={f} type="button" aria-pressed={filter === f}
                  className={`btn sm ${filter === f ? "primary" : ""}`} onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : CATEGORY_LABEL[f]} · {n}
                </button>
              );
            })}
          </div>
          {fromPage.size > 0 && (
            <div className="card" aria-live="polite">
              <div className="card-head">
                <h2>From the page just saved</h2>
                <span className="sub">
                  {page?.fileName ? `${page.fileName}${pageWhen ? `, saved ${pageWhen}` : ""}` : `${fromPage.size} ${fromPage.size === 1 ? "row" : "rows"}`}
                </span>
              </div>
              {first.length === 0 ? (
                <p style={{ color: "var(--ink-2)" }}>
                  {filter === "all" ? "No flag includes a row of that page." : "No flag of this type includes a row of that page."}
                </p>
              ) : (
                <FlagList flags={first} />
              )}
              <p className="small" style={{ color: "var(--ink-2)", marginTop: 10 }}>
                Flags about entries that are missing name no rows, so they are in the list below. <Link href="/flags" style={{ textDecoration: "underline" }}>Show one list</Link>
              </p>
            </div>
          )}
          <div className="card" aria-live="polite">
            {fromPage.size > 0 && <div className="card-head"><h2>Other flags</h2></div>}
            {entries.length === 0 ? (
              <p style={{ color: "var(--ink-2)" }}>
                No readings are saved yet, so there is nothing to check. <Link href="/capture" style={{ textDecoration: "underline" }}>Add a logbook page</Link>.
              </p>
            ) : flags.length === 0 ? (
              <p style={{ color: "var(--ink-2)" }}>The rules found nothing to verify in the {entries.length} saved {entries.length === 1 ? "entry" : "entries"}.</p>
            ) : (
              <FlagList flags={rest} />
            )}
          </div>
        </>
      )}

      <div className="card">
        <details className="fold" open={rulesOpen} onToggle={(e) => setRulesOpen(e.currentTarget.open)}>
          <summary>
            <h2 style={{ display: "inline" }}>What JalLog checks</h2>
            <span className="sub">{RULES.length} rules, run on every save</span>
          </summary>
          <ul className="rules">
            {RULES.map((r) => (
              <li key={r.id}>
                <b>{r.title}</b>
                <span><span className="tag">{CATEGORY_LABEL[r.category] ?? r.category}</span></span>
                <span className="what">{r.description}</span>
              </li>
            ))}
          </ul>
          <p className="small" style={{ marginTop: 10, color: "var(--ink-2)" }}>
            The rules are plain arithmetic on the saved readings, not a model&apos;s opinion, so the same register always gives the same flags.
          </p>
        </details>
      </div>
    </div>
  );
}
