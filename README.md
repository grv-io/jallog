# JalLog

**Paper plant logbooks, digitised and checked.** Photograph a page of the paper register of a sewage or effluent treatment plant; JalLog reads the page, has a person confirm every value, runs seventeen fixed rules on the readings (consent limits, missing entries, impossible, copied or suspiciously regular values), and prepares the monthly report. It works with both kinds of register found at Indian plants: three-shift sheets with lab readings, and one-row-a-day registers with meter readings and chemical dosing.

Built for **WCC Launchpad 30** (4–5 October 2026) · Track: **Everyday Automation** · Solo entry by Gaurav Agrawal.

## The problem

Every STP and ETP in India keeps an operation logbook: flow-meter readings, pH, DO, MLSS, blower or plant run hours, energy meter, chemicals dosed, operator signature, once per shift or once a day. It is a paper register, and the record matters legally:

- A Rajasthan pollution board consent order requires that a "daily record of running hours of pollution control measures and energy consumption shall be maintained in log book" ([RSPCB consent, 2017](https://environmentclearance.nic.in/writereaddata/Form-2/General1/01102018JYM4P94OValidCTO.pdf)).
- Haryana asks for a "copy of logbook for last 03 months maintained for operation of ETP/STP" with every consent application ([HSPCB procedure](https://hspcb.org.in/uploads/pages/cp_66ab4d8e8b6b5.pdf)).
- Karnataka's STP guide tells owners to "periodically check and validate all log books" ([KSPCB STP guide](https://prod-qt-images.s3.amazonaws.com/indiawaterportal/import/sites/default/files/iwp2/The_STP__guide__Design__operation__and__maintainance__Published__by__the__Karnataka__State__Pollution__Control__Board.pdf)).

But nobody reads a paper register until an inspection, so problems sit in it unseen:

- Of 900 operational municipal STPs whose status is known, only 578 meet their consented norms ([CPCB national inventory, 2021](https://cpcb.gov.in/openpdffile.php?id=UmVwb3J0RmlsZXMvMTIyOF8xNjE1MTk2MzIyX21lZGlhcGhvdG85NTY0LnBkZg%3D%3D)).
- In Bengaluru, 2,200+ apartment complexes hold STP consents, about 600 plants are operational, and the board itself says over half of those may not meet standards ([Citizen Matters](https://citizenmatters.in/bengaluru-apartments-stp-sewage-treatment/)).
- A field experiment in Gujarat found that 29% of third-party environmental audits falsely reported readings as compliant, with reported values bunched just under the limit ([Duflo, Greenstone, Pande and Ryan, QJE 2013](https://www.povertyactionlab.org/sites/default/files/research-paper/156_321_QJE_2013_Truth_Telling_Third_Party_Audits.pdf)).

The people who feel this are the **O&M contractor or facility manager** who is answerable for a plant they visit once a week, and the **operator** who is asked to re-type a register into a spreadsheet at month end. IoT monitoring exists, but sensor systems are listed at Rs 3.5–14 lakh; a small apartment or hospital plant has a register and a phone.

Full sourced notes, including what could not be verified, are in [`docs/research.md`](docs/research.md). One honest gap: we found no documented Indian case of a fabricated STP *logbook* specifically; the evidence above is for audit reports and online monitoring data.

### What a real register changed

During the build we read a published register from a small hospital STP (the scans are not in this repository and the plant is not named). It looked nothing like the three-shift lab sheet the first version assumed: one row per day, no shift letters and no lab values, only the date, inlet and outlet flow *meter readings*, plant start and close time, lime, alum and chlorine dosed (in grams or kilograms), energy meter start and close readings, sludge, and a signature. Seven parameters were added for it (two flow-meter readings, run hours, three dosing quantities, sludge) and every screen now handles a plant set to one row a day. On one page of that register the inlet and outlet meter readings are identical on all 14 rows, which the engine raises as something to verify (one meter serving both columns, or one column written from the other), not as a finding.

## What it does

1. **Capture.** One photo of the register page. The image is downscaled in the browser and sent to a vision model with a strict output schema.
2. **Review.** Every value appears in an editable table beside the photo. Cells the reader was unsure of are highlighted, and a whole column can be marked as checked once it has been compared with the photo. Nothing is saved until a person confirms. A page that is left half-checked is kept in the browser and comes back.
3. **Check.** A deterministic rule engine runs on every save and raises flags, each with the numbers involved and what a supervisor should physically go and verify.
4. **Report.** A monthly operation report (key figures, parameter summary, meter readings, daily record, readings outside limits, record-keeping observations, operator remarks, and a section on how the figures were worked out) that prints to A4 or PDF, plus CSV export and a WhatsApp summary.

### The screens

- **Overview**: entries recorded against entries expected, share of outlet readings within limits (or average daily volume from the meter, for a register with no lab columns), flags to verify, a coverage strip with one bar per shift or day, and a trend chart for every column that has data. Cumulative meters are charted as the increase since the previous reading.
- **Log**: every saved entry, newest first, with flagged cells tinted. Selecting a row opens the entry beside the photo it was read from, with what was written on the page, which cells the reader was unsure of and which a person changed. Entries can be corrected, added by hand, or deleted (with Undo). Filters: all, flagged only, by month; 200 rows at a time. **Download CSV** gives `<plant>-log-<YYYY-MM-DD>.csv` with a column per parameter plus `source`, `changed_by_person` and `digitised_at`; text cells are protected against spreadsheet formula injection.
- **Flags**: the flags, filterable by type, each linking to its entries in the Log, and the full list of rules.
- **Report**: the monthly report. Volumes come from meter readings where the register has them (a replaced meter and out-of-sequence readings are set aside and said so), otherwise from the sum of the entries.
- **Plant**: plant details, shifts per day (1 for a daily register), consent limits with three published starting sets, the two sample plants, and delete-all.

### The checks

| Rule | What it catches |
|---|---|
| Consent limit | An outlet reading (pH, BOD, COD, TSS, residual chlorine) outside the plant's own limits; back-to-back exceedances are grouped |
| Physical range | A value that cannot be a real reading (pH 71, a negative number, more than 24 run hours in a day), BOD above COD, a day's outflow well above its inflow, blower hours longer than the shift |
| Repeated readings | The same value for a measured parameter in a run of back-to-back entries. How long the run must be depends on the parameter: it is flagged only when a run that long would be unlikely given how often that parameter's readings agree elsewhere in the log (never fewer than 4) |
| Copied row | An entry whose lab readings all equal the previous entry's |
| Digit preference | Readings ending in 0 or 5 far more often than measurement would give, overall or under one operator's name |
| Flat line | A parameter that stays within one recording step for 25 or more readings while inlet flow varies |
| Missing entries | An expected shift (or, at a one-row-a-day plant, a day) with no entry; a break of more than 60 days is reported once |
| Entry date | An entry with no usable date, or dated more than 60 days away from the rest of the log (usually a mistyped year) |
| Duplicate entries | The same date and shift entered twice with different readings |
| BOD frequency | BOD entered in several shifts of the same day, although the test takes 3 days at 27 °C |
| Meter | An energy, inlet or outlet flow meter that goes down, or stands still while run hours are recorded. A fall next to a remark about a meter change is treated as a replaced meter: a low-severity reminder to note the old and new readings |
| Identical steps | A meter that rises by exactly the same amount six or more entries in a row |
| Twin meters | Inlet and outlet meter readings exactly equal on five or more entries |
| Flow gap | The outlet meter rising more than 15% faster than the inlet meter over three or more entries |
| SVI | SV30 and MLSS that disagree (sludge volume index outside 30–400 mL/g) |
| Limit hugging | Values bunched just under the limit, the pattern reported in the Gujarat audit study |
| Capture lag | A low-severity note, not a problem with the readings: entries digitised more than 3 days after the dates they record |

The rules are arithmetic on the saved readings, so the same register always gives the same flags. They are worded as things to verify, not findings against a person: a repeated reading can be a stuck probe as easily as a copied entry.

### Measured reading accuracy

`node scripts/eval-extract.mjs [baseUrl] [--pages …] [--truth …] [--wait s]` sends each page through the live extractor and compares every cell with known values. Measured on 4 October 2026:

| Pages | Written cells read correctly | Notes |
|---|---|---|
| Four generated sample pages (in `public/samples`) | 412 / 412 | Includes strike-through corrections, blank cells, ditto-mark dates, Hindi remarks, a different column layout, and a daily register with dosing written in grams |
| Two pages of a real hospital STP register (not in this repository) | 166 / 167 readable cells | One misread was returned with high confidence. A further 20 cells were left out of the score because the person writing down the true values could not read them either |

The generated pages use handwriting fonts, which are more regular than a real register, so treat the first row as an upper bound. The one confident misread on real handwriting is exactly why the review step exists: such an error is only caught by the person checking the page or, later, by a rule.

## Try it

- **Open a sample plant** on the first screen. Both hold generated readings, not a real plant's data, with known problems written in:
  - *3-shift plant with lab readings*: 30 days for a 250 KLD plant, with six night-shift rows copied from the one before, two missed shifts, a process upset with TSS and COD over the limit, a pH typed as 71, an energy-meter reading 650 kWh too low, BOD entered every shift for a week, and one operator whose readings nearly always end in 0 or 5.
  - *Daily register*: 45 rows over 46 days for a 10 KLD plant, with nine days of identical meter rises, five days where the outlet reading was written the same as the inlet, one missing day, and an energy meter replaced part-way (noted in the remarks).
- **Capture → sample page**: four generated register pages (clean 3-shift, messy 3-shift with strike-throughs and Hindi remarks, a different plant's layout with clock times, and a one-row-a-day meter and dosing register with D-M-YY dates). Pages 1, 2 and 4 continue the sample plants' records. If live reading is not available, a sample page opens with its stored reading and says so.
- **Plant → limits**: switch the limits to the NGT 2019 values (BOD 10, COD 50, TSS 20) and watch the same record go from mostly compliant to mostly not. Which limits bind a plant is decided by its consent order, so limits are per plant and editable.

## How it is built

- **Next.js 15 (App Router) + TypeScript**, no UI framework; charts are hand-written SVG.
- **Extraction** (`app/api/extract`, `lib/extract.ts`): Gemini vision with a JSON response schema, read as a stream so that a slow answer keeps the rows already written. The prompt forbids guessing blanks or "correcting" odd values, asks for a per-cell confidence, and converts units (grams to kilograms, start and close times to run hours) while keeping the text as written. The model's answer is treated as untrusted input and normalised (dates, shifts, numbers, unknown columns dropped) before it reaches the browser. If an answer is cut off, the rows that arrived are shown with a warning that the lower rows are missing. The route accepts requests only from its own page, limits each caller to 12 pages in 10 minutes, and takes a photo of at most 3 MB after compression.
- **Checks** (`lib/checks.ts`): pure functions with no I/O, covered by unit tests.
- **Report figures** (`lib/report.ts`): pure functions; the report and overview screens only lay them out.
- **Storage** (`lib/store.tsx`): IndexedDB in the browser. There is no database and no account. Readings stay in this browser. A photo is sent to Google's Gemini service to be read, and JalLog's server does not store it. Saves are merged with what another tab wrote, damaged stored data is repaired or reported rather than crashing a screen, and in a daily register a second page for the same dates (the facing page with the dosing columns) adds its columns instead of replacing the first page's.
- **Contract** (`lib/types.ts`): one file of shared types that the API, checks, seed data and UI all use.
- **Tests**: `npm test` runs 534 unit tests (rule engine, extraction normaliser and route, store, report figures, sample data, entry dialog, CSV export).

```
app/            screens: overview, capture, log, flags, report, plant
app/api/extract vision-model call, same-site check, rate limit
app/log/csv.ts  CSV export
components/     top bar, flag list, trend chart, entry dialog, welcome
lib/checks.ts   rule engine          lib/seed.ts    sample plant generators
lib/extract.ts  prompt, schema, output normaliser
lib/report.ts   monthly figures      lib/store.tsx  browser storage
lib/params.ts   parameter metadata and published limit sets
public/samples  generated register pages + their true values
scripts/        sample page generator, extraction eval
docs/           sourced research notes
```

### Run locally

```bash
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (free key from aistudio.google.com)
npm run dev
npm test
```

Without a key the app still runs; sample pages open with their stored readings and say so.

Two things to know when running or hosting it:

- **Free-tier quota.** A free Gemini key allows only a small number of requests a day per model (on 4 October 2026 the API reported a limit of 20 for `gemini-3.5-flash`). The route falls through a list of four models when one is out of quota or overloaded (`GEMINI_MODEL` in `.env.example`), and sample pages fall back to their stored reading. For sustained use, a paid key is needed.
- **Behind a proxy or tunnel.** The route checks that an upload comes from its own page. A host that rewrites the `Host` header without setting `X-Forwarded-Host` must list its public host name in `EXTRACT_ALLOWED_HOSTS`, or browser uploads get a 403. Hosts that preserve `Host` or set `X-Forwarded-Host` need nothing.

## Responsible design

- **A person confirms every value** before it enters the record, and the report says how many values were corrected at that step.
- **The model may not tidy the data.** A reading that looks wrong is transcribed as written, kept, and flagged, so the digital record matches the paper.
- **Flags are signals, not verdicts.** No scores for people, no "fraud" label; each flag says what to check on site.
- **Limits come from the consent order**, not from us. Presets cite their source and are editable.
- **Where the data goes.** Readings stay in this browser. A photo is sent to Google's Gemini service to be read, and JalLog's server does not store it.
- **Every entry keeps its origin.** The Log shows whether an entry was read from a photo, typed by hand or generated as sample data, what was written on the page, and which values a person changed.
- **Known limits.** Lab values are whatever the register says and are not independently tested. Handwriting the model misreads with high confidence is only caught by the human check or by a rule. The sample plants and sample pages are generated, not from a real plant; the welcome screen, the overview, the entry dialog and the printed report say so. When a second page is merged into a day's row, only the newer page's photo is kept with the entry.

## What is not built yet

- WhatsApp intake (operator sends the photo to a number; no app to open).
- Accounts and a shared database, so a contractor sees all sites in one place. Today the record lives in one browser; the CSV is the backup.
- Columns beyond the 20 parameters tracked today; a page's other columns are listed on the review screen but not stored.
- Missed-entry reminders, and Hindi UI for operators.
- A pilot at a plant. Reading has been measured on two pages of one real register; nobody at a plant has used it yet.

## Disclosure

- All code in this repository was written during the event window, starting from `create-next-app`. Built with Claude Code as the AI coding tool, as the rules allow.
- The sample logbook pages are rendered from HTML with handwriting fonts (`scripts/make-samples.mjs`); the sample plants' readings come from seeded generators (`lib/seed.ts`). Neither is real plant data.
- The real register used for testing is a published document. Its scans, its values and the plant's name are not in this repository.
- The idea predates the event (it was shortlisted on 26 September 2026); no code or design existed before 4 October.
