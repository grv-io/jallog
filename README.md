# JalLog

JalLog reads a photo of a page from the paper logbook of a sewage or effluent treatment plant (STP / ETP), shows every value to a person beside the photo to check, and saves the checked rows in the browser. Eighteen fixed rules then compare the readings with the plant's consent limits and point out missing entries and readings that are impossible, copied or unusually regular, and a monthly report is built from the same record.

- Live app: <https://jallog.vercel.app> (no login; live reading runs on a free model key with a small daily allowance)
- Code: <https://github.com/grv-io/jallog>
- Built for WCC Launchpad 30 (4–5 October 2026), track "Everyday Automation". Solo entry by Gaurav Agrawal.

Contents: [The problem](#the-problem) · [What it does](#what-it-does) · [The checks](#the-checks) · [Measured reading accuracy](#measured-reading-accuracy) · [Try it](#try-it) · [How it is built](#how-it-is-built) · [Responsible design](#responsible-design) · [Known limits](#known-limits) · [What is not built](#what-is-not-built) · [Field notes](#field-notes-to-be-added-by-the-entrant) · [Disclosure](#disclosure)

## The problem

Indian STPs and ETPs keep an operation logbook: flow-meter readings, pH, DO, MLSS, run hours, energy meter, chemicals dosed, operator signature, once per shift or once a day. The formats we found are paper registers, and regulators ask for the record:

- A Rajasthan pollution board consent order (for an industrial unit) requires that a "daily record of running hours of pollution control measures and energy consumption shall be maintained in log book" ([RSPCB consent, 2017](https://environmentclearance.nic.in/writereaddata/Form-2/General1/01102018JYM4P94OValidCTO.pdf)).
- Haryana asks for a "Copy of logbook for last 03 months maintained for operation of ETP/STP/APCM" with a consent-to-operate application ([HSPCB procedure](https://hspcb.org.in/uploads/pages/cp_66ab4d8e8b6b5.pdf)).
- Karnataka's STP guide tells owners to "Periodically check and validate all log books" ([KSPCB STP guide](https://prod-qt-images.s3.amazonaws.com/indiawaterportal/import/sites/default/files/iwp2/The_STP__guide__Design__operation__and__maintainance__Published__by__the__Karnataka__State__Pollution__Control__Board.pdf)).

What is known about how the plants behind those registers perform:

- Of 900 operational municipal STPs whose compliance status is known, 578 meet their consented norms ([CPCB national inventory, 2021](https://cpcb.gov.in/openpdffile.php?id=UmVwb3J0RmlsZXMvMTIyOF8xNjE1MTk2MzIyX21lZGlhcGhvdG85NTY0LnBkZg%3D%3D)).
- In Bengaluru, 2,200+ apartment complexes hold STP consents, about 600 plants are operational, and the board itself says over half of those may not meet standards ([Citizen Matters](https://citizenmatters.in/bengaluru-apartments-stp-sewage-treatment/)).
- A field experiment in Gujarat found that 29% of third-party environmental audits falsely reported a reading as within the standard, with reported values bunched just under the limit ([Duflo, Greenstone, Pande and Ryan, QJE 2013](https://www.povertyactionlab.org/sites/default/files/research-paper/156_321_QJE_2013_Truth_Telling_Third_Party_Audits.pdf)). That study covers industrial air and water audits, not STP logbooks.

Who we think has the problem: the O&M contractor or facility manager who answers for a plant they are not at every day, and the operator who is asked to type a register into a spreadsheet for a report or a consent renewal. Sensor-based monitoring exists, but listed systems cost about Rs 3.5–14 lakh ([IndiaMART listing](https://www.indiamart.com/proddetail/etp-stp-remote-monitoring-systems-13748179973.html)); a small apartment or hospital plant has a register and a phone.

What we could not source, stated plainly:

- **No documented Indian case of a fabricated or back-filled STP logbook was found.** The evidence above is for audit reports and online monitoring data. The rules that look for copied or regular readings are therefore checks for things to verify, not a claim that such entries are common.
- We found no source on how often anyone reads a register between inspections. That nobody does is our working assumption, not an established fact.
- Nobody at a plant has been interviewed yet. The [field notes](#field-notes-to-be-added-by-the-entrant) section is where that goes.

All sources, and a longer list of what could not be verified, are in [`docs/research.md`](docs/research.md).

### What a real register changed

During the build we tested on two pages of a published register from a small STP (the scans and the transcribed rows are not in this repository, and the plant is not named). It did not look like the three-shift lab sheet the first version assumed. It has one row per day, no shift letters and no lab values: the date, inlet and outlet flow *meter readings* (cumulative), plant start and close time, lime, alum and chlorine dosed (written in grams or kilograms), energy meter start and close readings, sludge, and a signature. It matches a pollution-board logbook format we had found earlier ([format](https://chocmms.nic.in/SPCB_DOCUMENTS/LogBookFormat.pdf)).

Seven parameters were added for it (two flow-meter readings, run hours, three dosing quantities, sludge) and every screen now handles a plant set to one row a day.

Its numbers are regular. In our by-eye transcription of one page, the inlet and outlet meter readings are identical on all 14 rows, and the energy meter rises by exactly 3 units on 10 of 13 days, the last six in a row (two of the readings involved were hard to read). On the other page the energy meter only ever rises by 5 or 10. Run on each transcribed page on its own, the current rules raise one medium flag per page: "inlet and outlet meters show the same reading" (14 of 14 rows) on the first, and "energy meter readings mostly end in 0 or 5" (16 of 16) on the second. The identical-steps rule does not fire on a single 14-row page: six equal rises in a row are not unusual enough on so short a record. Each of these has an innocent explanation (one meter serving both columns, a meter that counts in fives), which is why they are worded as things to verify. How typical this one register is, we do not know.

## What it does

1. **Capture.** One photo of the register page. The browser shrinks it to at most 2000 px on the long side and sends it to a vision model with a fixed output schema.
2. **Review.** Every value appears in an editable table with the photo beside it. Cells the reader was unsure of are yellow. Save stays disabled until each of those has been corrected or marked as compared with the photo (one column at a time, or all at once), and nothing enters the record until a person presses Save. A page left half-checked is kept in the browser and comes back.
3. **Check.** A rule engine with no model in it runs on every save and raises flags. Each flag carries the numbers involved and a sentence on what to go and verify.
4. **Report.** A monthly operation report that prints to A4 or PDF, a CSV export, and a text summary to share on WhatsApp. We found no single statutory format for a monthly STP report; the layout is ours.

### Two kinds of register

| | Shift sheet with lab readings | One-row-a-day meter and dosing register |
|---|---|---|
| Plant setting | Shifts per day: 2 or 3 | Shifts per day: 1 |
| A row is identified by | date + shift letter, or date + clock time | date alone (shift and time are not stored) |
| Typical columns | inlet and outlet flow, inlet and outlet pH, DO, MLSS, SV30, COD, BOD, TSS, residual chlorine, blower hours, energy meter | inlet and outlet flow meter readings, run hours (from start and close time), lime, alum and chlorine dosed in kg (grams converted), energy meter, sludge in kg |
| A second page for the same dates | replaces the rows for the same date and shift | adds its columns to the day's row, so the two facing pages of a register can be photographed separately |
| Missing-entry check | per shift | per day |
| Overview, second tile | share of outlet readings within limits | average daily volume from the flow meter, when the register has no columns with a limit |
| Volumes in the report | sum of the shift entries (the sheet records a volume per shift) | increases between flow meter readings |

The 20 parameters stored are the ones in the two "typical columns" cells above. Any other column on a page is listed on the review screen by its heading and not stored.

### The screens

- **Overview**: entries recorded against entries expected, the second tile described above, flags to verify by severity, a coverage strip with one bar per shift or day, and a trend chart for every column that has data. Cumulative meters are charted as the increase since the previous reading.
- **Capture**: add a page from the camera or a file, or try one of four generated sample pages. After Save it lists the flags that the page raised or that include its rows.
- **Log**: every saved entry, newest first, 200 rows at a time, with flagged cells marked by shape as well as tint. Selecting a row opens the entry beside the photo it was read from, with what was written on the page, which cells the reader was unsure of and which a person changed. Entries can be corrected, added by hand, or deleted (with Undo). Filters: all, flagged only, by month. **Download CSV** gives `<plant>-log-<YYYY-MM-DD>.csv` with a column for each parameter that has data plus `source`, `changed_by_person` and `digitised_at`; text cells are protected against spreadsheet formula injection.
- **Flags**: the flags, filterable by type, each linking to its entries in the Log, and the full list of rules as the engine describes them.
- **Report**: plant details and key figures, parameter summary, meter readings, daily record, readings outside consent limits, record-keeping observations, operator remarks, and "How the figures were worked out". It opens on the latest month with at least 7 recorded days and says so when it skips a newer, partial month. A figure the checks flag as far out of scale is shown as written, marked, and left out of totals and averages, and the report says so.
- **Plant**: plant details, shifts per day, consent limits with three published starting sets, a full copy to download (one JSON file with the plant, limits, entries and page photos) and restore, the two sample plants, and delete-all.

## The checks

These are the 18 rules in `lib/checks.ts`, with the thresholds the code uses. The Flags screen prints the same list from the same source. "Type" is the label the app shows.

| Rule (id) | Type | What raises it |
|---|---|---|
| Value outside consent limit (`limit`) | Consent limit | A reading above the maximum or below the minimum set for the plant. Limits can be entered for outlet pH, BOD, COD, TSS and residual chlorine. Exceedances in back-to-back readings are grouped into one flag; readings more than 2 days apart are reported separately. |
| Value that cannot be right (`physical`) | Plausibility | A value outside what the parameter can be (pH 71, a negative reading, more than 24 run hours in a day); BOD above COD in the same entry; a full day's outlet flow more than 15% above its inlet flow, or its inlet flow more than 3 times its outlet flow; blower hours longer than the shift. Also figures out of scale: a day's flow or a flow meter's rise above 3 times the design capacity; a dose above 5 kg of lime or alum, or 1 kg of chlorine, per m³ of daily capacity; a flow at least 5 times, or a dose at least 50 times, the column's usual figure (its median), or either one 50 times smaller; a meter that jumps by 20 times its usual rise. These are usually a slipped digit, a wrong unit or a wrong column. |
| Repeated readings (`repeat`) | Data quality | The same value for a measured parameter in a run of back-to-back readings, never fewer than 4. The run length needed depends on the parameter: it is flagged only when a run that long would be unlikely given how often that parameter's readings agree elsewhere in the log. High severity only when two or more parameters repeat over the same entries and at least one is finely recorded. A column recorded in coarse steps (at most 4 different values in the log, such as pH by paper strip) is judged by its own rate of agreement. |
| Row identical to the previous row (`rowcopy`) | Data quality | An entry whose lab readings (at least 4 of them) all equal the previous entry's, where that much agreement would be unlikely by chance. Flow figures are ignored. Consecutive such rows are grouped. |
| Readings mostly end in 0 or 5 (`digits`) | Data quality | At least 60% of a parameter's last digits are 0 or 5 (about 20% is expected). Tested on all values (30 or more) and per operator name (20 or more) where the rest of the log does not show the pattern. A column recorded only in whole numbers or steps of 0.5 is reported once as a low-severity note about the method. Not tested on BOD, COD, flows, MLSS, SV30, or a reading that barely moves. Meter readings are tested from 10 readings. |
| Reading almost constant while inflow varies (`flat`) | Data quality | A measured parameter other than pH stays within one recording step for 25 or more readings in a row, a stretch that would be unlikely given the rest of the log, while inlet flow for the same shifts varies by more than 10%. |
| Missing entries (`missing`) | Record keeping | Between the first and last entry, an expected shift (or day, at a one-row-a-day plant) with no entry. Each contiguous gap is one flag; a break of more than 60 days is reported once. When no day has as many entries as the plant setting expects (or most days have more), that is reported once as a setting to check, and the expected count follows what the register records. |
| Entry date needs checking (`date`) | Record keeping | An entry with no usable date, or dated more than 60 days from the rest of the log (usually a mistyped year). A nearer date is questioned only when the log itself points to a slip: up to 3 entries standing more than 7 days before or after everything else, where the same day of the neighbouring month is empty or the entry's meter reading belongs among earlier rows. A wrong date that lands inside the log's own period cannot be told from a right one. |
| Duplicate entries (`duplicate`) | Record keeping | The same date and shift entered more than once with different readings. Exact copies (the same page saved twice) are counted once by every other check. |
| BOD recorded more than once a day (`bodfreq`) | Plausibility | Outlet BOD entered in two or more shifts on the same day, on at least 3 days. The test takes 3 days at 27 °C. |
| Meter went backwards or stood still (`meter`) | Plausibility | An energy, inlet or outlet flow meter that goes down (high), unless the remarks on that or the neighbouring entry mention a meter change, or the fall follows a break of more than 60 days: then it is a low-severity reminder to confirm the old and new readings. A meter that does not move across an entry with run hours recorded is medium; a meter that only moves about one unit per entry is reported once, at low severity. |
| Meter rises in identical steps (`step`) | Data quality | A meter that rises by exactly the same amount in 6 or more entries in a row, or in at least 90% of all its rises, where that would be unlikely given how its rises vary elsewhere. Two meters stepping over the same entries are judged together. |
| Inlet and outlet meters show the same reading (`twin`) | Plausibility | Inlet and outlet flow meter readings exactly equal on 5 or more entries. |
| Outlet meter rising faster than inlet meter (`flowgap`) | Plausibility | The outlet reading rises by more than 15% above the inlet reading's rise in 3 or more entries in a row. |
| MLSS and SV30 give an unusual SVI (`svi`) | Plausibility | SVI = SV30 × 1000 / MLSS below 30 or above 400 mL/g. With SV30 at 900 mL/L or more, the flag says the sludge did not settle. |
| Readings cluster just under the limit (`hugging`) | Data quality | At least 70% of a parameter's values sit between 90% and 100% of its maximum limit (needs 15 or more values). This is the pattern the Gujarat audit study reported. Not applied to pH or to any limit that also has a minimum. |
| Entries digitised well after their dates (`backfill`) | Record keeping | A low-severity note, not a problem with the readings: entries photographed or typed in more than 3 days after the dates they record. |
| Entries dated after the page was photographed (`ahead`) | Data quality | An entry dated later than the day it was digitised (Indian time). Either the row was written before its day, or its date was misread. A night-shift row dated the next morning is not counted once that shift has begun. |

The rules are arithmetic on the saved readings, so the same register always gives the same flags. They are worded as things to verify: a repeated reading can be a stuck probe as easily as a copied entry.

What the generated sample data exercises: the 3-shift sample plant raises 11 flags from 8 rules (`repeat`, `rowcopy`, `limit`, `meter`, `physical`, `digits`, `missing`, `bodfreq`); the daily-register sample raises 6 flags from 4 rules (`meter`, `missing`, `step`, `twin`); saving a sample page can add `backfill` and `ahead`, depending on the day it is saved. `flat`, `date`, `duplicate`, `flowgap`, `svi` and `hugging` are not raised by any sample data and are covered by unit tests only. The thresholds are our own choices; they have not been calibrated on real registers.

## Measured reading accuracy

`node scripts/eval-extract.mjs [baseUrl] [--pages …] [--truth …] [--wait s]` sends each page through the extractor and compares every cell with known values. A cell is "written" when the known value is not blank.

| Pages | Run | Written cells correct | Wrong, marked sure | Wrong, marked unsure | Left blank | Invented |
|---|---|---|---|---|---|---|
| Four generated sample pages (`public/samples`) | Deployed site, after the first public push | 404 / 412 (98.1%) | 0 | 0 | 8 | 0 |
| Same four pages | The one answer per page kept in `scripts/samples/recorded.json` (4 October 2026; `gemini-3.5-flash` for pages 1–3, `gemini-3.5-flash-lite` for page 4) | 412 / 412 | 0 | 0 | 0 | 0 |
| Two pages of a real small-plant register, 30 rows (not in this repository) | `gemini-3.5-flash`, 4 October 2026, two runs with the same score | 166 / 167 | 1 | 0 | 0 | 0 |
| Same two real pages | Earlier run, before a prompt change, answered by fallback models | 154 / 167 | 0 | 13 | 0 | 0 |

How to read these:

- **Deployed run.** The 8 blanks were one flow column on sample page 3. The main model was busy, a lighter fallback model answered, and it left that column unmapped. On the review screen, columns the reader did not map are listed under the table by their headings, and a missing column can be added and typed in by hand. Pages took 11 to 38 seconds.
- **Recorded answers.** These are the answers kept with the sample pages so that a sample still opens when live reading is unavailable. They are answers we kept, so read 412 / 412 as what a good run looks like, not as an average. 10 of the 412 cells were marked unsure (all correct). Results differ from run to run and by which model in the fallback list answers; in one browser walkthrough of the build, a live read of sample page 2 left at least two cells unread.
- **Generated pages are easier than real ones.** They use handwriting fonts, which are more regular than a person's writing.
- **Real pages.** 20 cells were left out of the score because they could not be read with confidence when the true values were written down. The one wrong cell is an energy meter reading with a last digit misread (5 read as 8), returned as sure. The reader marked 43 of the 167 scored cells unsure, all of them correct, mostly grams converted to kilograms. In the earlier run, all 13 errors were one column where a handwritten "g" after the number was read as a 9; each was marked unsure, and the prompt now names that case.
- **What the real-page figure is not.** The true values are a by-eye transcription of the scans made during the build with the AI coding tool. No second person checked it and it was not compared with the plant's own records. It is one register, two pages, read from scans rather than phone photos. The kept runs were made before the last round of edits to the extraction code, and no later run on the real pages is recorded.
- **Not measured:** accuracy on phone photos taken at a plant, on Hindi-language column headings, or on any register other than this one.

The confident misread on real handwriting is why the review step exists: such an error is caught only by the person comparing the page, or later by a rule. When a sample page is read live, the review screen states how many of its cells matched and lists the ones that did not.

## Try it

Open <https://jallog.vercel.app>. Nothing needs installing and there is no login.

1. **Open the 3-shift sample plant.** The overview shows 88 of 90 shifts recorded, 97.2% of outlet readings within limits (137 of 141), and 6 high and 5 medium flags. This is a generated month for a 250 KLD plant, with problems written in: six night-shift rows copied from the one before, two missed shifts, a process upset with TSS and COD over the limit, a pH typed as 71, an energy-meter reading 650 kWh too low, BOD entered every shift for a week, and one operator name whose DO and chlorine readings nearly always end in 0 or 5.
2. **Flags.** Each flag has the numbers, a "Verify" line and, where it names entries, a link to them in the Log. "What JalLog checks" lists the 18 rules.
3. **Plant → Consent limits → Use** beside "NGT order, 30 April 2019" (BOD 10, COD 50, TSS 20), then **Save plant**. On the sample plant as loaded, the share within limits falls from 97.2% to 68.1% (96 of 141) and the limit flags go from 2 to 12. Which limits bind a plant is decided by its consent order, so limits are per plant and editable. Put the limits back before the next step: **Use** beside "2017 notification (non-metro) + COD 250", then **Save plant**.
4. **Capture → "Messy 3-shift STP page".** A generated page with strike-through corrections, blank cells, Hindi remarks and a skewed photo. Check the yellow cells against the photo, mark them as checked, and press Save. The checks then report, among others, an outlet TSS of 142 mg/L and a night-shift row identical to the row before it. Saved before 5 October 2026, its rows dated 5 October also raise "dated after the page was photographed".
5. **Overview → "Switch to the daily-register sample".** It asks first, because it replaces the sample plant you have just added a page to. 45 rows over 46 days for a 10 KLD plant: 45 of 46 entries, an average outlet volume of 7.5 m³ a day from the meter, and 6 flags (two meters rising in identical steps for nine days, the outlet reading written the same as the inlet on five days, the outlet meter then going down, one missing day, and an energy meter replaced part-way and noted in the remarks).
6. **Capture → "One row a day, small plant meter register".** Dates written D-M-YY, dosing in grams and kilograms, start and close times. If it is read correctly, saving it adds a third identical-steps flag (energy meter up by exactly 3 kWh on 8 entries, 27 September to 4 October) and the same-reading flag grows to 15 of 59 entries.
7. **Report → Print / save PDF.**

Things to know while trying it:

- The four sample pages are: a clean 3-shift page, the messy one, a different plant's layout with clock times instead of shift letters, and the daily register. Pages 1, 2 and 4 continue the sample plants' records. Page 3 is headed with another plant's name; the app says so and asks before saving it into a sample plant. Picking a page of the other register kind offers to switch sample plant first.
- Live reading on the deployed site is limited, because it runs on a free key: by default 10 model calls a day per visitor and 40 per server instance. When the allowance is used up, or the model is unavailable, a sample page opens with the answer recorded earlier and says so in its heading. Your own photos cannot be read until the allowance returns.
- Do not upload a real register page with names or signatures to the deployed site. See [Responsible design](#responsible-design).

## How it is built

```
phone or desktop browser
  photo → shrink to ≤ 2000 px JPEG ──POST──▶ app/api/extract (Next.js route, Node runtime)
                                               same-site check · size check · burst and daily limits
                                               Gemini vision, JSON schema, streamed, fallback list of 4 models
                                               normalise: dates, shifts, numbers, units; unknown columns dropped
  review table beside the photo ◀── rows, per-cell text as written + sure/unsure ──┘
  person corrects, marks unsure cells as checked, presses Save
        │
        ▼
  IndexedDB in this browser (lib/store.tsx): plant, entries, page photos
        │
        ▼
  lib/checks.ts (18 rules, pure functions) ──▶ overview · log · flags
  lib/report.ts (monthly figures, pure functions) ──▶ report · overview
```

- **Next.js 15 (App Router), React 19, TypeScript.** No UI framework; plain CSS; charts are hand-written SVG. One runtime dependency besides Next and React: `idb-keyval`.
- **Extraction** (`app/api/extract/route.ts`, `lib/extract.ts`). The prompt forbids filling blanks or "correcting" odd values, asks for the text exactly as written plus a sure/unsure mark for every cell, maps column headings to parameters by meaning, and treats anything written on the page as content, never as an instruction. The model's answer is treated as untrusted input: dates, shifts and times are normalised, each number is checked against the text the model says is written in the cell, a value that disagrees with its own text or that was converted from another unit (grams to kilograms, start and close times to hours) is marked unsure, and unknown columns are dropped. The answer is read as a stream, so if a model stops part-way the rows that arrived are shown with a warning that the lower rows are missing. Notes the model wrote are prefixed "Reader:" so they cannot pass for the route's own warnings.
- **Limits on the route.** A photo of at most 3 MB after compression; 12 pages per caller and 60 across all callers in 10 minutes; per server instance 40 model calls a day in total and 10 per visitor (`EXTRACT_DAILY_LIMIT`, `EXTRACT_DAILY_PER_CALLER`). A repeat read of the same photo within six hours is answered from memory without a model call. A model that reports no quota is skipped for up to 30 minutes. The counts are held in memory, so they reset on restart and each serverless instance keeps its own.
- **Checks** (`lib/checks.ts`). Pure functions: no I/O, no clock, no randomness.
- **Report figures** (`lib/report.ts`). Pure functions; the report and overview screens only lay them out. The count of expected entries is the rule engine's, and a test holds the two together.
- **Storage** (`lib/store.tsx`). IndexedDB in the browser; no database and no accounts. Saves are merged with what another tab wrote, damaged stored data is repaired or reported instead of crashing a screen, and a refused write (private window, storage full) shows a banner and keeps the work in the tab.
- **Contract** (`lib/types.ts`). One file of shared types used by the route, the checks, the sample data and the screens.
- **Tests.** `npm test` runs 757 unit tests in 9 files (counted on 4 October 2026): extraction normaliser and route 314, rule engine 162, report figures 116, store 78, entry dialog 44, sample plants 31, CSV 8, sample pages 4.

```
app/               screens: overview (page.tsx), capture, log, flags, report, plant; error and not-found pages
app/api/extract    the vision-model route
app/log/csv.ts     CSV export
components/        top bar, welcome, flag list, trend chart, entry dialog
lib/types.ts       shared contract            lib/params.ts   parameter metadata, published limit sets
lib/extract.ts     prompt, schema, normaliser lib/checks.ts   rule engine
lib/report.ts      monthly figures            lib/store.tsx   browser storage
lib/seed.ts        the two generated sample plants
public/samples     four generated register pages and the values they were generated from
scripts/           sample page generator, extraction eval, recorded sample readings
docs/              research notes with sources; submission notes
```

### Run locally

```bash
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (a free key from aistudio.google.com)
npm run dev
npm test
```

Without a key the app still runs: your own photos cannot be read, and sample pages open with the answer recorded earlier (or the values the page was generated from) and say which.

- **Free-tier quota.** A free Gemini key allows a small number of requests a day per model (on 4 October 2026 the API reported a limit of 20 for `gemini-3.5-flash`). The route falls through a list of four models when one is out of quota or overloaded (`GEMINI_MODEL` in `.env.example`).
- **Behind a proxy or tunnel.** The route refuses a browser upload whose `Origin` is not its own host. A host that rewrites the `Host` header without setting `X-Forwarded-Host` must list its public host name in `EXTRACT_ALLOWED_HOSTS`. Vercel needs nothing.

Deployment notes are in [`docs/SUBMISSION.md`](docs/SUBMISSION.md).

## Responsible design

- **A person sees every value beside the photo before it enters the record.** Cells the reader was unsure of block Save until they are corrected or marked as checked. The entry keeps what was written on the page, which cells were unsure and which a person changed, and the report says how many values were changed.
- **The model may not tidy the data.** A reading that looks wrong is transcribed as written, kept, and flagged, so the digital record matches the paper.
- **Flags are things to verify, not verdicts.** There are no scores for people and no "fraud" label, and each flag says what to check on site. One rule compares readings by the operator name written on the page: the per-operator part of the digit-preference rule. The name appears only in that flag's detail sentence, never in a title, and no other flag mentions a name. The Flags screen says that a flag is not a finding against a person and that no flags does not certify the plant.
- **Limits come from the plant's consent order.** The three published sets are starting points, each with its source, and every limit is editable.
- **Where the data goes.** The saved record stays in the browser it was saved in. The photo of the page, with everything written on it, goes through JalLog's server to Google's Gemini service to be read; JalLog's server does not keep it (it keeps the reading of a photo in memory for up to six hours to answer a repeat). On a free Gemini key, Google may keep the photo, use it to improve its products and have people review it ([terms for unpaid use](https://ai.google.dev/gemini-api/terms)), so pages with names or signatures on them need a paid key. The deployed site uses a free key. The capture screen says this where the photo is chosen.
- **Generated data is labelled.** The sample plants and sample pages are generated. The welcome screen, the overview, the entry dialog, the CSV and the printed report say so, including for a sample page that the live reader read.
- **The rules state their blind spots.** The date rule says that a wrong date inside the log's own period cannot be told from a right one, and the Flags screen says that the rules only see what was written down and saved.

## Known limits

- **The check is only as good as the person doing it.** "Mark as checked" can be pressed without looking. The app records that a person confirmed; it cannot know that they compared.
- **Confident misreads.** A value the model misreads and marks sure is not highlighted. On two real pages that happened once in 167 cells.
- **Lab values are whatever the register says.** Nothing here tests the water.
- **The rules have not been calibrated on real registers.** They were developed against generated data and the two real pages. How often they flag an honest register is not known.
- **One browser holds the record.** Clearing site data deletes it. The backup is Plant → "Download a full copy"; the CSV cannot be loaded back.
- **The route's limits are a brake, not a guarantee.** The same-site check stops another website using a visitor's browser; a script can call the route directly, and the caller's address comes from a header. The counts are per serverless instance.
- **Reading needs a connection.** Pages took 11 to 38 seconds each on the deployed site. There is no offline mode.
- **Merged pages keep one photo.** When a second page is merged into a day's row in a daily register, only the newer page's photo stays with the entry.
- **Energy meter columns with start and close readings** store the close reading only.
- **Column headings in Hindi** were not tested. Hindi remarks are kept in their own script.
- **Verification state on the evening of 4 October 2026:** type check, lint, the unit tests and a production build pass. An automated browser walkthrough of both sample plants was re-run on the final build (every screen at desktop and 390 px phone width, two live readings): no console errors, no failed steps, no horizontal overflow. It is a scripted walkthrough, not a substitute for use on a real plant.

## What is not built

- WhatsApp intake (the operator sends the photo to a number and opens no app).
- Accounts and a shared database, so that a contractor sees several plants in one place and a supervisor sees what the operator saved.
- Columns beyond the 20 parameters. Other columns on a page are listed on the review screen and not stored.
- Reminders for missed entries, and a Hindi interface.
- Any pilot. Nobody at a plant has used it.

## Field notes: to be added by the entrant

*Nothing in this section has been collected yet. It is left empty on purpose and will be filled in by the entrant after visiting a campus STP. The checklist for that visit is in [`docs/SUBMISSION.md`](docs/SUBMISSION.md#3-field-checklist-10-minutes-at-a-campus-stp).*

- Date of visit:
- Plant (type, capacity, process; no name unless the plant agrees):
- Kind of register (rows per day, columns):
- Q1. Who writes the register, and when:
- Q2. Who reads it afterwards, and how often:
- Q3. Is any of it typed up again, by whom, and how long it takes:
- Q4. Which columns come from an instrument, and how many flow meters there are:
- Q5. Would they photograph the page each day, and what would stop them:
- Reading a real page from this plant (cells right, wrong, unsure):
- What this changes in JalLog:

## Disclosure

- All code in this repository was written during the event, starting from `create-next-app` (first commit 4 October 2026). It was built with Claude Code as the AI coding tool.
- The four sample logbook pages are rendered from HTML with handwriting fonts (`scripts/make-samples.mjs`). The two sample plants' readings come from seeded generators (`lib/seed.ts`). Neither is real plant data, and the plant names on them are invented.
- The real register used for testing is a published document. Its scans, its transcribed rows and the plant's name are not in this repository; only the summary observations in this README and in `docs/research.md` are.
- The idea predates the event: it was shortlisted on 26 September 2026. No code or design existed before 4 October.
