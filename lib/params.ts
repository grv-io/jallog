import type { Limits, ParamKey, ParamMeta, ShiftCode } from "./types";

export const PARAMS: Record<ParamKey, ParamMeta> = {
  inletFlow: {
    key: "inletFlow", label: "Inlet flow", short: "In flow", unit: "m³", decimals: 0,
    physicalMin: 0, physicalMax: 100000, kind: "reading", varies: true,
  },
  outletFlow: {
    key: "outletFlow", label: "Outlet flow", short: "Out flow", unit: "m³", decimals: 0,
    physicalMin: 0, physicalMax: 100000, kind: "reading", varies: true,
  },
  phInlet: {
    key: "phInlet", label: "Inlet pH", short: "pH in", unit: "", decimals: 1,
    physicalMin: 0, physicalMax: 14, typicalMin: 6, typicalMax: 9, kind: "reading", varies: true,
  },
  phOutlet: {
    key: "phOutlet", label: "Outlet pH", short: "pH out", unit: "", decimals: 1,
    physicalMin: 0, physicalMax: 14, typicalMin: 6.5, typicalMax: 8.5, kind: "reading", varies: true,
  },
  doAeration: {
    key: "doAeration", label: "Aeration tank DO", short: "DO", unit: "mg/L", decimals: 1,
    physicalMin: 0, physicalMax: 12, typicalMin: 1.5, typicalMax: 4, kind: "reading", varies: true,
  },
  mlss: {
    key: "mlss", label: "MLSS", short: "MLSS", unit: "mg/L", decimals: 0,
    physicalMin: 0, physicalMax: 20000, typicalMin: 2000, typicalMax: 5000, kind: "reading", varies: true,
  },
  sv30: {
    key: "sv30", label: "SV30", short: "SV30", unit: "mL/L", decimals: 0,
    physicalMin: 0, physicalMax: 1000, typicalMin: 150, typicalMax: 400, kind: "reading", varies: true,
  },
  codOutlet: {
    key: "codOutlet", label: "Outlet COD", short: "COD", unit: "mg/L", decimals: 0,
    physicalMin: 0, physicalMax: 5000, kind: "reading", varies: true,
  },
  bodOutlet: {
    key: "bodOutlet", label: "Outlet BOD", short: "BOD", unit: "mg/L", decimals: 0,
    physicalMin: 0, physicalMax: 3000, kind: "reading", varies: true,
  },
  tssOutlet: {
    key: "tssOutlet", label: "Outlet TSS", short: "TSS", unit: "mg/L", decimals: 0,
    physicalMin: 0, physicalMax: 5000, kind: "reading", varies: true,
  },
  residualChlorine: {
    key: "residualChlorine", label: "Residual chlorine", short: "Cl₂", unit: "mg/L", decimals: 1,
    physicalMin: 0, physicalMax: 10, typicalMin: 0.2, typicalMax: 1, kind: "reading", varies: true,
  },
  blowerHours: {
    key: "blowerHours", label: "Blower run hours", short: "Blower", unit: "h", decimals: 1,
    physicalMin: 0, physicalMax: 24, kind: "reading", varies: false,
  },
  energyKwh: {
    key: "energyKwh", label: "Energy meter", short: "kWh meter", unit: "kWh", decimals: 0,
    physicalMin: 0, physicalMax: 100000000, kind: "cumulative", varies: false,
  },
  inletTotaliser: {
    key: "inletTotaliser", label: "Inlet flow meter reading", short: "In meter", unit: "m³", decimals: 0,
    physicalMin: 0, physicalMax: 1000000000, kind: "cumulative", varies: false,
  },
  outletTotaliser: {
    key: "outletTotaliser", label: "Outlet flow meter reading", short: "Out meter", unit: "m³", decimals: 0,
    physicalMin: 0, physicalMax: 1000000000, kind: "cumulative", varies: false,
  },
  runHours: {
    key: "runHours", label: "Plant run hours", short: "Run", unit: "h", decimals: 1,
    physicalMin: 0, physicalMax: 24, kind: "reading", varies: false,
  },
  limeKg: {
    key: "limeKg", label: "Lime dosed", short: "Lime", unit: "kg", decimals: 2,
    physicalMin: 0, physicalMax: 10000, kind: "reading", varies: false,
  },
  alumKg: {
    key: "alumKg", label: "Alum dosed", short: "Alum", unit: "kg", decimals: 2,
    physicalMin: 0, physicalMax: 10000, kind: "reading", varies: false,
  },
  chlorineKg: {
    key: "chlorineKg", label: "Chlorine / hypo dosed", short: "Cl dose", unit: "kg", decimals: 2,
    physicalMin: 0, physicalMax: 10000, kind: "reading", varies: false,
  },
  sludgeKg: {
    key: "sludgeKg", label: "Sludge removed", short: "Sludge", unit: "kg", decimals: 1,
    physicalMin: 0, physicalMax: 1000000, kind: "reading", varies: false,
  },
};

// The order columns are shown in (review table, log, entry form, CSV). It
// follows the paper: a lab sheet runs flows, pH, lab values, chlorine, blower,
// energy; a daily register runs flow meters, run time, dosing, energy, sludge.
// PARAM_KEYS keeps the order the keys were added in, which put the energy
// meter ahead of the flow meters and made the table hard to compare with the photo.
export const COLUMN_ORDER: ParamKey[] = [
  "inletFlow", "outletFlow", "phInlet", "phOutlet", "doAeration", "mlss", "sv30", "codOutlet", "bodOutlet", "tssOutlet",
  "residualChlorine", "inletTotaliser", "outletTotaliser", "runHours", "blowerHours", "limeKg", "alumKg", "chlorineKg",
  "energyKwh", "sludgeKg",
];

export const SHIFTS: Record<ShiftCode, { label: string; start: string; end: string; hours: number }> = {
  A: { label: "A (06–14)", start: "06:00", end: "14:00", hours: 8 },
  B: { label: "B (14–22)", start: "14:00", end: "22:00", hours: 8 },
  C: { label: "C (22–06)", start: "22:00", end: "06:00", hours: 8 },
};

export function shiftsFor(perDay: 1 | 2 | 3): ShiftCode[] {
  return perDay === 1 ? ["A"] : perDay === 2 ? ["A", "B"] : ["A", "B", "C"];
}

// Published limit sets for treated sewage/effluent, with where each comes from
// (sources in docs/research.md). Which one binds a given plant is decided by
// its own consent order, so these are starting points the user can overwrite.
export const LIMIT_PRESETS: { id: string; label: string; note: string; limits: Limits }[] = [
  {
    id: "moefcc-2017",
    label: "2017 notification (non-metro) + COD 250",
    note: "MoEFCC G.S.R. 1265, Oct 2017: pH 6.5–9.0, BOD 30, TSS 100. COD 250 is taken from the general standards, since the 2017 notification sets none.",
    limits: { phOutlet: { min: 6.5, max: 9.0 }, bodOutlet: { max: 30 }, codOutlet: { max: 250 }, tssOutlet: { max: 100 } },
  },
  {
    id: "ngt-2019",
    label: "NGT order, 30 April 2019",
    note: "pH 5.5–9.0, BOD 10, COD 50, TSS 20. The order applies these to new and existing STPs across the country.",
    limits: { phOutlet: { min: 5.5, max: 9.0 }, bodOutlet: { max: 10 }, codOutlet: { max: 50 }, tssOutlet: { max: 20 } },
  },
  {
    id: "general-1986",
    label: "General standards (inland surface water)",
    note: "Environment (Protection) Rules, Schedule VI: pH 5.5–9.0, BOD 30, COD 250, TSS 100. The usual base for industrial ETP consents.",
    limits: { phOutlet: { min: 5.5, max: 9.0 }, bodOutlet: { max: 30 }, codOutlet: { max: 250 }, tssOutlet: { max: 100 } },
  },
];

export const DEFAULT_LIMITS: Record<"STP" | "ETP", Limits> = {
  STP: LIMIT_PRESETS[0].limits,
  ETP: LIMIT_PRESETS[2].limits,
};

export function fmt(key: ParamKey, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  return v.toFixed(PARAMS[key].decimals);
}
