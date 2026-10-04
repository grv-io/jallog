// Shared contract for JalLog. Every module (extraction API, checks engine,
// seed data, UI) reads and writes these shapes. Change here first.

export const PARAM_KEYS = [
  "inletFlow",
  "outletFlow",
  "phInlet",
  "phOutlet",
  "doAeration",
  "mlss",
  "sv30",
  "codOutlet",
  "bodOutlet",
  "tssOutlet",
  "residualChlorine",
  "blowerHours",
  "energyKwh",
  // Columns found on real small-plant registers (daily rows, meter readings,
  // chemical dosing) rather than on lab-style shift sheets.
  "inletTotaliser",
  "outletTotaliser",
  "runHours",
  "limeKg",
  "alumKg",
  "chlorineKg",
  "sludgeKg",
] as const;

export type ParamKey = (typeof PARAM_KEYS)[number];

export type ShiftCode = "A" | "B" | "C";

export interface ParamMeta {
  key: ParamKey;
  label: string;
  short: string; // column heading in dense tables
  unit: string;
  decimals: number;
  // Hard physical bounds. A value outside these cannot be a real reading.
  physicalMin: number;
  physicalMax: number;
  // Usual healthy operating band, when one exists. Informational.
  typicalMin?: number;
  typicalMax?: number;
  // "cumulative" = a meter reading that must never go down (energy meter).
  kind: "reading" | "cumulative";
  // True when the value is a lab/instrument measurement that should vary
  // naturally from shift to shift. Used by the fabrication-signal rules.
  varies: boolean;
}

// Consent limits for treated water. min/max are inclusive; omit a side that
// has no limit. Only outlet parameters normally carry limits.
export type Limits = Partial<Record<ParamKey, { min?: number; max?: number }>>;

export interface Plant {
  id: string;
  name: string;
  kind: "STP" | "ETP";
  location: string;
  capacityKld: number;
  technology: string; // e.g. "MBBR", "SBR", "ASP"
  operatorCompany: string;
  consentNo: string;
  shiftsPerDay: 1 | 2 | 3;
  limits: Limits;
}

export type CellConfidence = "high" | "low";

export interface CellMeta {
  raw: string; // exactly what was written on the page
  confidence: CellConfidence;
}

export interface LogEntry {
  id: string;
  plantId: string;
  date: string; // YYYY-MM-DD
  shift: ShiftCode | null;
  time: string | null; // HH:MM, 24h, when the page gives a clock time
  operator: string | null;
  values: Partial<Record<ParamKey, number | null>>;
  remarks: string | null;
  // Present for entries that came from a photographed page.
  pageId: string | null;
  cellMeta?: Partial<Record<ParamKey, CellMeta>>;
  // Parameters a human changed during review.
  edited?: ParamKey[];
  // ISO timestamp of when the entry was digitised (page upload or manual add).
  capturedAt: string;
}

export interface LogPage {
  id: string;
  plantId: string;
  uploadedAt: string; // ISO
  fileName: string;
  imageDataUrl: string; // downscaled JPEG
  model: string; // which extractor produced the rows ("sample" for demo pages)
  notes: string[]; // extractor's own caveats about the page
  reviewedAt: string | null;
}

export type Severity = "high" | "medium" | "low";

export type FlagCategory = "compliance" | "integrity" | "completeness" | "plausibility";

export interface Flag {
  id: string; // stable: ruleId + scope, so re-running gives the same ids
  ruleId: string;
  category: FlagCategory;
  severity: Severity;
  title: string; // short, e.g. "Outlet BOD above consent limit"
  detail: string; // one or two plain sentences with the numbers
  // What a supervisor should go and check. Flags are signals, not verdicts.
  verify: string;
  param?: ParamKey;
  date?: string; // first affected date
  entryIds: string[];
}

export interface ChecksResult {
  flags: Flag[];
  expectedShifts: number;
  recordedShifts: number;
  // Share of outlet readings with a limit that are inside it, 0..1. null when
  // there are no such readings.
  complianceRate: number | null;
}

// ---- Extraction API (POST /api/extract) ----

export interface ExtractRequest {
  imageDataUrl: string; // data:image/jpeg;base64,...
  plantKind: "STP" | "ETP";
  // Used when the page omits the year or the date entirely.
  fallbackDate: string; // YYYY-MM-DD
}

export interface ExtractedRow {
  date: string | null; // YYYY-MM-DD
  shift: ShiftCode | null;
  time: string | null;
  operator: string | null;
  values: Partial<Record<ParamKey, number | null>>;
  cellMeta: Partial<Record<ParamKey, CellMeta>>;
  remarks: string | null;
}

export interface ExtractResponse {
  ok: true;
  model: string;
  rows: ExtractedRow[];
  // Column headings on the page that did not map to any ParamKey. At most
  // MAX_UNMAPPED_COLUMNS of them.
  unmappedColumns: string[];
  // At most MAX_NOTES items of at most MAX_NOTE_CHARS UTF-16 units each. Two
  // sources share the list: notes the model wrote start with
  // READER_NOTE_PREFIX; the route's own warnings (a date it could not use, a
  // unit it converted, a cut-off answer) do not, and come first.
  notes: string[];
}

export const MAX_NOTES = 20;
export const MAX_NOTE_CHARS = 300;
export const MAX_UNMAPPED_COLUMNS = 20;

// Put in front of every note the model wrote. Notes can repeat text from the
// page, so a note must never pass for one of the route's own warnings
// ("Row 3: ...", or the cut-off warning the review screen shows in red).
export const READER_NOTE_PREFIX = "Reader: ";

// When the model's answer stops part-way down the page, the route still
// returns the rows it has and puts a note that starts with this text first in
// "notes". The review screen looks for it to show the warning above the table.
export const CUT_OFF_NOTE_PREFIX = "The reader's answer was cut off";

export interface ExtractError {
  ok: false;
  // "forbidden": the request did not come from the JalLog page (403).
  // "bad_request": not sent as JSON (415).
  // "bad_image": the photo itself is unusable or too large (400, 413), or the
  // vision model could not open it (422).
  // "no_key": no API key is configured, or the model service refused the key (503).
  // "not_a_logbook": the photo was read but holds no register rows (422).
  // "model_error": the model failed or its answer could not be used (500, 502,
  // 504); also 503 when none of the configured models exists, and 499 when the
  // caller hung up.
  // "rate_limited": 429, always with a Retry-After header (seconds). Covers the
  // burst limit, the daily budget and the model service's own quota.
  code: "no_key" | "bad_image" | "bad_request" | "forbidden" | "not_a_logbook" | "model_error" | "rate_limited";
  message: string;
}
