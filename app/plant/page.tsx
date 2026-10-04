"use client";

import { useEffect, useRef, useState } from "react";
import { Confirm, downloadJson } from "@/components/TopBar";
import { DEFAULT_LIMITS, LIMIT_PRESETS, PARAMS } from "@/lib/params";
import { PRIVACY_COPY, formatDateTime, localToday, readBackup, uid, useStore } from "@/lib/store";
import type { BackupRead, DemoKind } from "@/lib/store";
import { PARAM_KEYS } from "@/lib/types";
import type { Limits, ParamKey, Plant } from "@/lib/types";

const LIMIT_PARAMS: ParamKey[] = ["phOutlet", "bodOutlet", "codOutlet", "tssOutlet", "residualChlorine"];
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
// Larger than any treatment plant; catches litres typed where kilolitres are meant.
const MAX_CAPACITY_KLD = 10_000_000;
// A full copy holds every page photo (up to about 3 MB each). Past this the
// browser would have to hold the file several times over to read it.
const MAX_COPY_BYTES = 300 * 1024 * 1024;

type Side = "min" | "max";

// The form holds numbers as the text the user typed, so "abc" or "7." can be
// shown back and explained instead of being silently dropped.
interface Form {
  id: string;
  name: string;
  kind: Plant["kind"];
  location: string;
  capacity: string;
  technology: string;
  operatorCompany: string;
  consentNo: string;
  shiftsPerDay: 1 | 2 | 3;
  limits: Record<string, Record<Side, string>>;
  // Limits on parameters this screen has no row for, carried through untouched.
  otherLimits: Limits;
}

const numText = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");

function limitsToText(limits: Limits | undefined): Form["limits"] {
  return Object.fromEntries(LIMIT_PARAMS.map((k) => [k, { min: numText(limits?.[k]?.min), max: numText(limits?.[k]?.max) }]));
}

function toForm(plant: Plant | null): Form {
  if (!plant) {
    return {
      id: uid("plant"), name: "", kind: "STP", location: "", capacity: "", technology: "", operatorCompany: "", consentNo: "",
      shiftsPerDay: 3, limits: limitsToText(DEFAULT_LIMITS.STP), otherLimits: {},
    };
  }
  const otherLimits: Limits = {};
  for (const k of PARAM_KEYS) {
    const l = plant.limits?.[k];
    if (l && !LIMIT_PARAMS.includes(k)) otherLimits[k] = { ...(l.min !== undefined ? { min: l.min } : {}), ...(l.max !== undefined ? { max: l.max } : {}) };
  }
  return {
    id: plant.id, name: plant.name ?? "", kind: plant.kind === "ETP" ? "ETP" : "STP", location: plant.location ?? "",
    capacity: plant.capacityKld > 0 ? numText(plant.capacityKld) : "", technology: plant.technology ?? "",
    operatorCompany: plant.operatorCompany ?? "", consentNo: plant.consentNo ?? "",
    shiftsPerDay: plant.shiftsPerDay === 1 || plant.shiftsPerDay === 2 ? plant.shiftsPerDay : 3,
    limits: limitsToText(plant.limits), otherLimits,
  };
}

// null = blank, undefined = not a number
function parseNum(s: string): number | null | undefined {
  const t = s.trim();
  if (!t) return null;
  if (!NUMBER_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

// Returns the plant to save, or the reasons it cannot be saved yet.
function check(form: Form): { plant: Plant | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = form.name.trim();
  if (!name) errors.name = "Enter the plant's name.";

  const capacity = parseNum(form.capacity);
  if (capacity === null) errors.capacity = "Enter the design capacity in KLD (kilolitres a day).";
  else if (capacity === undefined || capacity <= 0) errors.capacity = "Capacity must be a number above 0.";
  else if (capacity > MAX_CAPACITY_KLD) errors.capacity = "That is larger than any treatment plant. Capacity is in kilolitres a day, not litres.";

  const limits: Limits = {};
  for (const k of PARAM_KEYS) {
    if (!LIMIT_PARAMS.includes(k)) {
      if (form.otherLimits[k]) limits[k] = form.otherLimits[k];
      continue;
    }
    const meta = PARAMS[k];
    const range = k === "phOutlet" ? "pH limits must be between 0 and 14." : `Must be between ${meta.physicalMin} and ${meta.physicalMax} ${meta.unit}.`;
    const side: Partial<Record<Side, number>> = {};
    for (const s of ["min", "max"] as const) {
      const v = parseNum(form.limits[k]?.[s] ?? "");
      if (v === null) continue;
      if (v === undefined) errors[`${k}.${s}`] = "Not a number.";
      else if (v < meta.physicalMin || v > meta.physicalMax) errors[`${k}.${s}`] = range;
      else side[s] = v;
    }
    if (side.min !== undefined && side.max !== undefined && side.min >= side.max) {
      errors[`${k}.max`] = "The maximum must be above the minimum.";
    }
    if (side.min !== undefined || side.max !== undefined) {
      limits[k] = { ...(side.min !== undefined ? { min: side.min } : {}), ...(side.max !== undefined ? { max: side.max } : {}) };
    }
  }

  if (Object.keys(errors).length > 0 || typeof capacity !== "number") return { plant: null, errors };
  return {
    errors,
    plant: {
      id: form.id, name, kind: form.kind, location: form.location.trim(), capacityKld: capacity,
      technology: form.technology.trim(), operatorCompany: form.operatorCompany.trim(), consentNo: form.consentNo.trim(),
      shiftsPerDay: form.shiftsPerDay, limits,
    },
  };
}

const presetFor = (kind: Plant["kind"]) => LIMIT_PRESETS.find((p) => p.limits === DEFAULT_LIMITS[kind]);

export default function PlantPage() {
  const { ready, plant, entries, pages, savePlant, loadDemo, reset, exportCopy, restoreCopy } = useStore();
  const [form, setForm] = useState<Form>(() => toForm(null));
  // The form exactly as it was last taken from the saved plant. While the
  // form still equals this, nothing typed here can be lost by reloading it.
  const [baseline, setBaseline] = useState("");
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stale, setStale] = useState(false);
  const [offerLimits, setOfferLimits] = useState<Plant["kind"] | null>(null);
  const [confirming, setConfirming] = useState<DemoKind | "delete" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A full copy the user chose, read and waiting for the go-ahead.
  const [incoming, setIncoming] = useState<{ copy: BackupRead; fileName: string } | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [working, setWorking] = useState<"download" | "read" | null>(null);
  const copyRef = useRef<HTMLInputElement>(null);
  const seen = useRef<string | null>(null);
  // Bumped to make the effect below take the saved plant again even when the
  // plant itself did not change (deleting when there was no plant, say).
  const [resync, setResync] = useState(0);

  // Compared as form text, so a plant re-read from storage with its keys in
  // another order does not count as a change.
  const plantKey = plant ? JSON.stringify(toForm(plant)) : "";

  // Follow the saved plant (first load, a sample plant loaded, a change made
  // in another tab), but never over the top of edits in progress.
  useEffect(() => {
    if (!ready || seen.current === plantKey) return;
    const first = seen.current === null;
    seen.current = plantKey;
    const current = JSON.stringify(form);
    if (first || current === baseline || current === plantKey) {
      const next = toForm(plant);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setStale(false);
      setOfferLimits(null);
      setTried(false);
    } else {
      setStale(true);
    }
  }, [ready, plantKey, plant, form, baseline, resync]);

  if (!ready) return null;

  const { plant: valid, errors } = check(form);
  const show = (key: string) => (tried || (key === "capacity" && form.capacity.trim() !== "") ? errors[key] : undefined);
  const limitErrors = LIMIT_PARAMS.flatMap((k) =>
    (["min", "max"] as const).filter((s) => errors[`${k}.${s}`]).map((s) => `${PARAMS[k].label} ${s === "min" ? "minimum" : "maximum"}: ${errors[`${k}.${s}`]}`),
  );

  function change(patch: Partial<Form>) {
    setForm((f) => ({ ...f, ...patch }));
    setSaved(false);
    setMessage(null);
  }

  function setLimit(k: ParamKey, side: Side, text: string) {
    setForm((f) => ({ ...f, limits: { ...f.limits, [k]: { ...(f.limits[k] ?? { min: "", max: "" }), [side]: text } } }));
    setSaved(false);
  }

  // A published set fills in the parameters it covers and leaves the others
  // (residual chlorine, say) as the user set them.
  function applyPreset(limits: Limits) {
    setForm((f) => {
      const next = { ...f.limits };
      for (const k of LIMIT_PARAMS) if (limits[k]) next[k] = { min: numText(limits[k]?.min), max: numText(limits[k]?.max) };
      return { ...f, limits: next };
    });
    setSaved(false);
    setOfferLimits(null);
  }

  function changeKind(kind: Plant["kind"]) {
    change({ kind });
    // The usual starting limits differ between sewage and effluent plants.
    // Offer them; never swap the limits in the table without being asked.
    const preset = DEFAULT_LIMITS[kind];
    const differs = LIMIT_PARAMS.some(
      (k) => preset[k] && (form.limits[k]?.min !== numText(preset[k]?.min) || form.limits[k]?.max !== numText(preset[k]?.max)),
    );
    setOfferLimits(differs ? kind : null);
  }

  function adopt(next: Plant | null) {
    const f = toForm(next);
    const key = JSON.stringify(f);
    seen.current = next ? key : "";
    setForm(f);
    setBaseline(key);
    setStale(false);
    setOfferLimits(null);
    setTried(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) {
      setTried(true);
      setSaved(false);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#plant-form [aria-invalid="true"]')?.focus());
      return;
    }
    adopt(valid);
    savePlant(valid);
    setSaved(true);
    setMessage(null);
  }

  function runConfirmed(action: DemoKind | "delete") {
    setConfirming(null);
    setSaved(false);
    // Whatever is in the form belongs to the plant being replaced.
    seen.current = null;
    setResync((n) => n + 1);
    if (action === "delete") {
      reset();
      setMessage("The plant, its entries and the stored page photos were deleted from this browser.");
    } else if (loadDemo(action)) {
      setMessage(`The ${action === "daily" ? "daily-register" : "3-shift"} sample plant is loaded. Its readings are generated, not from a real plant.`);
    } else {
      seen.current = plantKey;
      setMessage("That sample plant is not available in this build.");
    }
  }

  async function downloadCopy() {
    if (working) return;
    setWorking("download");
    setCopyError(null);
    try {
      const copy = await exportCopy();
      const name = (plant?.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      downloadJson(`jallog-copy${name ? `-${name}` : ""}-${localToday()}.json`, copy);
      const photos = Object.keys(copy.photos).length;
      const missing = copy.pages.length - photos;
      setMessage(
        `A full copy was handed to the browser to save: the plant and its limits, ${copy.entries.length} ${copy.entries.length === 1 ? "entry" : "entries"} and ${photos} page ${photos === 1 ? "photo" : "photos"}.` +
          (missing > 0 ? ` ${missing} page ${missing === 1 ? "photo is" : "photos are"} not stored in this browser and could not be included.` : ""),
      );
    } catch {
      setCopyError("The copy could not be made in this browser. The CSV on the Log screen still downloads the readings.");
    } finally {
      setWorking(null);
    }
  }

  async function chooseCopy(files: FileList | null) {
    const f = files?.[0];
    if (!f || working) return;
    setCopyError(null);
    setMessage(null);
    setIncoming(null);
    const name = f.name.length > 48 ? `${f.name.slice(0, 45)}…` : f.name || "the file";
    if (f.size === 0) {
      setCopyError(`${name} is empty (0 bytes).`);
      return;
    }
    if (f.size > MAX_COPY_BYTES) {
      setCopyError(`${name} is ${Math.round(f.size / 1024 / 1024)} MB, which is too large to be a JalLog copy.`);
      return;
    }
    setWorking("read");
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await f.text());
      } catch {
        setCopyError(`${name} is not a JalLog copy: it could not be read as JSON. Choose the .json file made by "Download a full copy". A CSV cannot be loaded back in.`);
        return;
      }
      const copy = readBackup(parsed);
      if (!copy) {
        setCopyError(`${name} does not hold a JalLog plant, so there is nothing to restore from it.`);
        return;
      }
      setIncoming({ copy, fileName: name });
    } catch {
      setCopyError(`${name} could not be opened.`);
    } finally {
      setWorking(null);
    }
  }

  async function restoreIncoming() {
    if (!incoming) return;
    const { copy } = incoming;
    setIncoming(null);
    setSaved(false);
    // Whatever is in the form belongs to the plant being replaced.
    seen.current = null;
    setResync((n) => n + 1);
    const stored = await restoreCopy(copy);
    const photos = Object.keys(copy.photos).length;
    const what = `${copy.state.plant?.name ?? "The plant"}, ${copy.state.entries.length} ${copy.state.entries.length === 1 ? "entry" : "entries"} and ${photos} page ${photos === 1 ? "photo" : "photos"}`;
    setMessage(
      stored
        ? `Restored from the copy: ${what}. All readings were checked again.`
        : `${what} are on screen, but this browser has not stored them yet (see the message at the top of the page).`,
    );
  }

  const hasData = Boolean(plant) || entries.length > 0;
  const withSlot = entries.filter((e) => e.shift || e.time).length;
  const preset = offerLimits ? presetFor(offerLimits) : undefined;
  const invalid = (key: string) => (errors[key] ? true : undefined);

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>Plant</h1>
          <p>Details printed on the monthly report, and the limits every outlet reading is checked against.</p>
        </div>
      </div>

      {stale && (
        <div className="notice warn" role="status">
          <p>The saved plant was changed somewhere else (another tab) while this form was being edited. Saving here will replace that change.</p>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" className="btn sm" onClick={() => adopt(plant)}>Load the saved version instead</button>
            <button type="button" className="btn sm" onClick={() => setStale(false)}>Keep my edits</button>
          </div>
        </div>
      )}

      <form className="stack" id="plant-form" noValidate onSubmit={submit}>
        <div className="card">
          <div className="card-head"><h2>Details</h2></div>
          <div className="form-grid">
            <label className="field">Plant name
              <input
                value={form.name} maxLength={80} placeholder="e.g. Green Park Apartments STP" required
                aria-invalid={tried ? invalid("name") : undefined} aria-describedby={show("name") ? "err-name" : undefined}
                onChange={(e) => change({ name: e.target.value })}
              />
              {show("name") && <span className="err" id="err-name">{show("name")}</span>}
            </label>
            <label className="field">Type
              <select value={form.kind} onChange={(e) => changeKind(e.target.value === "ETP" ? "ETP" : "STP")}>
                <option value="STP">STP (sewage)</option>
                <option value="ETP">ETP (industrial effluent)</option>
              </select>
            </label>
            <label className="field">Location
              <input value={form.location} maxLength={80} onChange={(e) => change({ location: e.target.value })} />
            </label>
            <label className="field">Capacity (KLD)
              <input
                value={form.capacity} inputMode="decimal" maxLength={12} placeholder="e.g. 100" required
                aria-invalid={show("capacity") ? true : undefined} aria-describedby={show("capacity") ? "err-capacity" : undefined}
                onChange={(e) => change({ capacity: e.target.value })}
              />
              {show("capacity") && <span className="err" id="err-capacity">{show("capacity")}</span>}
            </label>
            <label className="field">Process
              <input value={form.technology} maxLength={40} placeholder="MBBR, SBR, ASP…" onChange={(e) => change({ technology: e.target.value })} />
            </label>
            <label className="field">Shifts per day
              <select
                value={form.shiftsPerDay} aria-describedby="hint-shifts"
                onChange={(e) => change({ shiftsPerDay: e.target.value === "1" ? 1 : e.target.value === "2" ? 2 : 3 })}
              >
                <option value={1}>1 (daily register)</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
              <span className="hint" id="hint-shifts">
                Choose 1 for a daily register: one row a day (meter readings, dosing), with no shift letters.
              </span>
            </label>
            <label className="field">Operated by
              <input value={form.operatorCompany} maxLength={80} onChange={(e) => change({ operatorCompany: e.target.value })} />
            </label>
            <label className="field">Consent no.
              <input value={form.consentNo} maxLength={60} onChange={(e) => change({ consentNo: e.target.value })} />
            </label>
          </div>
          {plant && form.shiftsPerDay !== plant.shiftsPerDay && entries.length > 0 && (
            <p className="notice warn" style={{ marginTop: 12 }}>
              {form.shiftsPerDay === 1
                ? `With one row a day, a new page for a date replaces every entry saved for that date.${withSlot > 0 ? ` ${withSlot} saved ${withSlot === 1 ? "entry carries" : "entries carry"} a shift letter or a time.` : ""}`
                : `The ${entries.length} saved ${entries.length === 1 ? "entry was" : "entries were"} logged against ${plant.shiftsPerDay} ${plant.shiftsPerDay === 1 ? "row" : "shifts"} a day. With ${form.shiftsPerDay} shifts a day the checks will count the other shifts on those dates as missing.`}
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Consent limits for treated water</h2>
          </div>
          <p className="small" style={{ color: "var(--ink-2)", marginBottom: 12 }}>
            Enter the values printed on this plant&apos;s own consent to operate. Those are what legally apply, and they differ
            between states, plant ages and discharge points. The published sets below are starting points: Use fills in the
            parameters a set covers and leaves the others as they are.
          </p>
          {offerLimits && preset && (
            <div className="confirm" role="group" aria-label="Starting limits for the new plant type" style={{ marginBottom: 12 }}>
              <p>
                The type is now {offerLimits}. The usual starting point for an {offerLimits} is &ldquo;{preset.label}&rdquo;. The limits
                in the table have not been changed.
              </p>
              <div className="row">
                <button type="button" className="btn sm" onClick={() => setOfferLimits(null)}>Keep the limits in the table</button>
                <button type="button" className="btn sm primary" onClick={() => applyPreset(preset.limits)}>Use the {offerLimits} starting limits</button>
              </div>
            </div>
          )}
          <div className="stack" style={{ gap: 8, marginBottom: 14 }}>
            {LIMIT_PRESETS.map((p) => (
              <div className="row" key={p.id} style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
                <button type="button" className="btn sm" aria-label={`Use ${p.label}`} onClick={() => applyPreset(p.limits)}>Use</button>
                <span className="small"><b>{p.label}.</b> <span style={{ color: "var(--ink-2)" }}>{p.note}</span></span>
              </div>
            ))}
          </div>
          <div className="table-wrap">
            <table className="data">
              {/* The unit sits under the name: a fourth column did not fit a 360 px phone. */}
              <thead><tr><th className="l">Parameter</th><th>Minimum</th><th>Maximum</th></tr></thead>
              <tbody>
                {LIMIT_PARAMS.map((k) => (
                  <tr key={k}>
                    <td className="l" style={{ whiteSpace: "normal" }}>
                      {PARAMS[k].label}
                      <span className="muted" style={{ display: "block", fontSize: 12 }}>{PARAMS[k].unit || "pH units"}</span>
                    </td>
                    {(["min", "max"] as const).map((s) => (
                      <td className="tight" key={s}>
                        <input
                          className={`cell boxed ${errors[`${k}.${s}`] ? "invalid" : ""}`} inputMode="decimal" maxLength={10}
                          aria-label={`${PARAMS[k].label} ${s === "min" ? "minimum" : "maximum"}`} aria-invalid={invalid(`${k}.${s}`)}
                          value={form.limits[k]?.[s] ?? ""} onChange={(e) => setLimit(k, s, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {limitErrors.length > 0 && (
            <ul className="errs" role="alert">
              {limitErrors.map((t) => <li key={t}>{t}</li>)}
            </ul>
          )}
          <p className="muted small" style={{ marginTop: 10 }}>Leave a box empty where the consent sets no limit. A reading is flagged only against the limits entered here.</p>
        </div>

        <div className="row">
          <button className="btn primary" type="submit">Save plant</button>
          {saved && <span className="small" role="status" style={{ color: "var(--good-text)" }}>Saved. All readings re-checked against these limits.</span>}
          {tried && !valid && <span className="small err" role="alert">Not saved yet: correct the marked fields.</span>}
        </div>
      </form>

      <div className="card">
        <div className="card-head"><h2>Data on this device</h2></div>
        <p className="small" style={{ color: "var(--ink-2)", marginBottom: 12 }}>
          {entries.length} {entries.length === 1 ? "entry" : "entries"} and {pages.length} page {pages.length === 1 ? "photo" : "photos"} are
          stored here. {PRIVACY_COPY} Clearing this site&apos;s data in the browser deletes them. A full copy is one file with the plant,
          its limits, every entry and the page photos; it can be loaded back in here or in another browser. The CSV on the Log screen
          holds the readings only and cannot be loaded back in.
        </p>
        {message && <p className="notice" role="status" style={{ marginBottom: 12 }}>{message}</p>}
        {copyError && <p className="notice bad" role="alert" style={{ marginBottom: 12 }}>{copyError}</p>}
        {incoming ? (
          <Confirm
            text={
              `Restore from ${incoming.fileName}? It holds ${incoming.copy.state.plant?.name ?? "a plant"}, ${incoming.copy.state.entries.length} ${incoming.copy.state.entries.length === 1 ? "entry" : "entries"} and ${Object.keys(incoming.copy.photos).length} page ${Object.keys(incoming.copy.photos).length === 1 ? "photo" : "photos"}` +
              `${formatDateTime(incoming.copy.exportedAt) ? `, copied on ${formatDateTime(incoming.copy.exportedAt)}` : ""}.` +
              (incoming.copy.repaired
                ? ` Parts of the file were damaged${incoming.copy.dropped > 0 ? `: ${incoming.copy.dropped} ${incoming.copy.dropped === 1 ? "item" : "items"} could not be read and will be left out` : " and were repaired"}.`
                : "") +
              (hasData
                ? ` This replaces ${plant ? plant.name : "what is stored here"} and its ${entries.length} ${entries.length === 1 ? "entry" : "entries"} in this browser, and cannot be undone.`
                : "")
            }
            no="Cancel" yes="Restore from this copy" danger={hasData}
            onNo={() => setIncoming(null)} onYes={() => void restoreIncoming()}
          />
        ) : confirming ? (
          <Confirm
            text={
              confirming === "delete"
                ? `Delete ${plant ? plant.name : "the plant"}, all ${entries.length} ${entries.length === 1 ? "entry" : "entries"} and every stored page photo from this browser? This cannot be undone. Download the CSV from the Log screen first if you need the readings.`
                : `Replace ${plant ? plant.name : "what is stored here"} and its ${entries.length} ${entries.length === 1 ? "entry" : "entries"} with the ${confirming === "daily" ? "daily-register" : "3-shift"} sample plant? This cannot be undone. Download the CSV from the Log screen first if you need the readings.`
            }
            no="Cancel" yes={confirming === "delete" ? "Delete everything" : "Replace with the sample plant"} danger
            onNo={() => setConfirming(null)} onYes={() => runConfirmed(confirming)}
          />
        ) : (
          <div className="row">
            <button type="button" className="btn" onClick={() => void downloadCopy()} disabled={!hasData || working !== null}>
              {working === "download" ? "Making the copy…" : "Download a full copy"}
            </button>
            <input
              ref={copyRef} type="file" accept="application/json,.json" hidden tabIndex={-1} aria-hidden
              onChange={(e) => { void chooseCopy(e.target.files); e.target.value = ""; }}
            />
            <button type="button" className="btn" onClick={() => copyRef.current?.click()} disabled={working !== null}>
              {working === "read" ? "Reading the file…" : "Restore from a copy"}
            </button>
            <button type="button" className="btn" onClick={() => (hasData ? setConfirming("shift") : runConfirmed("shift"))}>Load the 3-shift sample plant</button>
            <button type="button" className="btn" onClick={() => (hasData ? setConfirming("daily") : runConfirmed("daily"))}>Load the daily-register sample plant</button>
            <button type="button" className="btn danger" onClick={() => setConfirming("delete")}>Delete all data</button>
          </div>
        )}
      </div>
    </div>
  );
}
