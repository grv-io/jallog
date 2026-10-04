# JalLog: submission notes

For the entrant. Four parts: the text to paste into the Unstop form, a shot list for the 2-minute video, a checklist for a 10-minute visit to a campus STP, and the deployment notes.

Every figure below is taken from the README, which says where each one comes from. If a figure changes there, change it here too.

- Live app: <https://jallog.vercel.app>
- Code: <https://github.com/grv-io/jallog>
- Submission closes 5 October 2026, 14:00 IST.

---

## 1. Submission text (about 350 words)

**JalLog: paper treatment-plant logbooks, read from a photo and checked**

**Problem.** Sewage and effluent treatment plants in India record flow, pH, run hours, energy and chemical dosing in a paper register, every shift or every day. Regulators ask for it: a Rajasthan consent order requires a daily log book of running hours and energy, and Haryana wants three months of logbook with a consent application. Nothing checks a paper register until someone reads it row by row.

**Who has it.** The O&M contractor or facility manager who answers for a plant they are not at every day, and the operator who writes the register. Sensor monitoring is listed at Rs 3.5–14 lakh; a small apartment or hospital plant has a register and a phone.

**Evidence.** CPCB's 2021 inventory: of 900 operational STPs with known status, 578 meet their norms. A Gujarat field experiment (QJE 2013) found 29% of environmental audits falsely reported compliance, with values bunched just under the limit. We found no documented Indian case of a fabricated STP logbook. On one page of a real published small-plant register we tested, the inlet and outlet meter readings are identical on every row.

**Solution.** Photograph a page. A vision model transcribes it; a person checks every value beside the photo, and cells the model was unsure of block saving until they are confirmed. Eighteen fixed rules flag limit breaches, missing entries, impossible values, copied rows and meters rising in identical steps, each with what to verify on site. A monthly report prints from the same record. It handles three-shift lab sheets and one-row-a-day meter and dosing registers.

**Technology.** Next.js 15, TypeScript, Gemini vision with a JSON schema, a deterministic rule engine, browser storage (IndexedDB), 757 unit tests. Live at jallog.vercel.app; code at github.com/grv-io/jallog.

**Real and generated.** Sample plants and sample pages are generated and labelled. Measured reading: 404 of 412 cells on the generated pages on the deployed site; 166 of 167 legible cells on two real register pages, with one misread returned as sure. Nobody at a plant has used it yet.

**Roadmap.** Field visit and pilot at one plant; rules calibrated on real registers; WhatsApp intake; accounts for contractors with several plants; Hindi interface.

*Before pasting: if the field visit in part 3 has happened, replace "Nobody at a plant has used it yet" with one true sentence about what was seen.*

---

## 2. Demo video: shot list (2 minutes)

### Before recording

- Push the latest commit and check the deployment first (part 4). Record on <https://jallog.vercel.app>, not on localhost and not on a per-deployment URL.
- Use a normal desktop browser window (not a private window), zoom 100%.
- Start with no plant, so the welcome screen shows: **Plant → Delete all data → Delete everything**, then click **Overview**.
- Live reading has a daily allowance (by default 10 model calls per visitor). Rehearse at most once. A repeat of the same sample page within six hours is usually answered from memory and costs nothing.
- Look at the first line under "Check the reading". If it says "from an earlier reading of … Nothing was read just now", the live reader was not available and you are looking at a recorded answer. Either say so in the video or record later. Do not present a recorded answer as a live read.
- Reading took 11 to 38 seconds a page on the deployed site. Cut the wait in editing and put "reading time cut" on screen where you do.
- The numbers in the sentences below are what the app shows for the sample data as loaded. If a number on your screen differs, say the number on the screen.
- Have a second tab open on the README on GitHub, scrolled to "Measured reading accuracy", for the last shot.

### Shots

| # | Time | On screen, exact clicks | Say (one sentence) |
|---|---|---|---|
| 1 | 0:00–0:10 | The welcome screen. No clicks; hold on the heading and the sample page photo. | "Treatment plants in India keep a paper logbook because their consent orders ask for one, and JalLog turns a photo of a page into a record that is checked." |
| 2 | 0:10–0:25 | Click **Open the 3-shift sample plant**. Move the pointer across the four tiles, then down to "Needs attention". | "This is a generated month for a 250 KLD plant: 88 of 90 shifts recorded, 97.2% of outlet readings within limits, and six high-severity flags to verify." |
| 3 | 0:25–0:50 | Click **Capture** in the top bar. Under "No register to hand? Try a sample page", click the card **Messy 3-shift STP page**. Cut the wait. On "Check the reading": click one yellow cell, so the line beside the photo shows "Written on page"; click **I have compared all … with the photo: mark as checked**; click **Save 12 rows**. | "A vision model reads the page, every value is shown beside the photo, and the cells it was unsure of are yellow and block Save until a person has compared them." |
| 4 | 0:50–1:05 | The Capture screen now shows "12 rows saved to the log and checked." Scroll slowly through "What the checks found on this page". | "Fixed rules run on every save: on this page they find an outlet TSS of 142 against a limit of 100, and a night-shift row identical to the one before it." |
| 5 | 1:05–1:22 | Click **See all flags**. In "From the page just saved", under "Outlet TSS outside consent limit", click **Show the entry in the log**. In the Log, click the row. The entry opens beside its photo. Click **Close**. | "Each flag gives the numbers, says what to verify on site, and leads back to the entry and the photo it came from; it is a point to check, not a finding against a person." |
| 6 | 1:22–1:40 | Click **Overview**. Click **Switch to the daily-register sample**, then **Replace with the sample plant**. Point at the tiles. In "Needs attention", click **All 6 flags** and scroll the list. | "The second kind of register is one row a day of meter readings and dosing, modelled on a real small-plant register we tested, and here the rules find two meters rising in identical steps and outlet readings written the same as the inlet." |
| 7 | 1:40–1:52 | Click **Report**. Scroll past the key figures to "Meter readings" and "How the figures were worked out". Click **Print / save PDF**, show the preview, cancel it. | "The monthly report comes from the same record, takes volumes from the meter readings, and says how each figure was worked out." |
| 8 | 1:52–2:00 | Switch to the README tab at "Measured reading accuracy". | "On two pages of a real register the reader got 166 of 167 legible cells right and one wrong with full confidence, which is why a person checks every page before it is saved." |

Notes on the shots:

- Shot 3: if the reader marks no cell as unsure, there is no yellow cell and no "mark as checked" button, and Save is already enabled. Say "none were unsure on this read" and go on. If the reader misread a cell, the review screen lists it under "Where the reading differs from the sample page"; correcting one on camera is a better demonstration than a clean read.
- Shot 4: if the video is recorded before 5 October 2026, the list also shows "Entries dated after the page was photographed" for the rows dated 5 October, and the review screen warns that rows are dated tomorrow. That is the rule working on the sample page's dates, not a fault.
- Shot 6: the generated sample contains these patterns by construction. Say "generated" if there is room; the tag "Generated sample data, not a real plant" is on screen.
- Do not show or name the real register. The video may say only what the README says about it.

---

## 3. Field checklist: 10 minutes at a campus STP

The aim is to replace assumptions with what one operator says and what one real page does. Nothing from this visit exists yet; nothing in the README may be written as if it did.

### Before going

- Ask whoever is in charge of the plant for permission to look at the register and to photograph it. Say it is for a student project and that the plant will not be named without their agreement.
- Do not upload a page with names or signatures to the deployed site. It uses a free model key, and on a free key Google may keep the photo and have people review it. Photograph with the signature column covered or cropped out, or read the page later on a local build with a paid key.
- Take a phone, and a sheet of paper to cover the signature column.

### What to photograph (minutes 1 to 4)

1. One filled register page, straight on, the whole table in frame, signature column covered.
2. The same page as an operator would take it: one-handed, at an angle, in the room's own light.
3. The column headings, close up.
4. The facing page, if the register runs across two pages.
5. The flow meter and the energy meter displays, to see what the smallest step on each is.
6. The page of the consent order that lists the discharge limits and any logbook condition, if they are willing to show it.

No people in any photo.

### Five questions for the operator (minutes 4 to 9)

1. Who writes the register, and when: at the moment of the reading, or at the end of the shift or day? How long does it take?
2. Who reads the register afterwards, and how often? When did someone last ask to see it?
3. Is any of it typed up again, for a monthly report, a consent renewal or the contractor? Who does that, and how long does it take?
4. Which columns are read from an instrument, and which are lab results or estimates? Is there one flow meter or two? What do you write when a meter is not working or has been replaced?
5. If photographing the page each day saved the typing, would you do it? What would stop you: the phone, the network, permission, language?

Write the answers down in their words. Do not improve them.

### Last minute

- Ask whether the plant may be described (type, capacity, process) without its name.
- Thank them.

### Where the answers go

In `README.md`, the section **"Field notes: to be added by the entrant"**. It has one line per item: date, plant (no name unless agreed), kind of register, Q1 to Q5, what happened when a real page from this plant was read (cells right, wrong, unsure), and what it changes in JalLog. Delete the italic line that says nothing has been collected, and fill in only what was seen and said. Then:

- In the README's "The problem" section, the third bullet under "What we could not source" says nobody at a plant has been interviewed. Change it to say one operator has, and link to the field notes.
- If the visit contradicts something in the README (who reads the register, how the columns are filled), change the README to match the visit, not the other way round.
- Do not commit the photographs of the real register to the repository.

---

## 4. Deployment (Vercel)

### Current state

The app is already deployed at <https://jallog.vercel.app> from the public GitHub repository `grv-io/jallog`, branch `master`. Use the production address everywhere (form, video, README). The per-deployment URLs that Vercel creates for each build ask for a Vercel login.

### To publish a change

1. Commit and push to `master` on GitHub.
2. Vercel builds the pushed commit and, when the build succeeds, makes it the production deployment at the same address. Watch it under the project's **Deployments** tab until it shows as ready and current.
3. Run the checks below.

`.env.local` holds the API key and is not committed. Never paste the key into a file in the repository, a commit message or the submission form.

### Environment variables

Set in the Vercel project under **Settings → Environment Variables**, for Production:

- `GEMINI_API_KEY` (required): the Google AI Studio key. Without it the site still opens, own photos cannot be read, and sample pages open with their recorded answers.
- Optional, described in `.env.example`: `GEMINI_MODEL`, `GEMINI_THINKING`, `EXTRACT_DAILY_LIMIT`, `EXTRACT_DAILY_PER_CALLER`. `EXTRACT_ALLOWED_HOSTS` is not needed on Vercel.

A new or changed variable takes effect only in the next deployment: after saving it, open **Deployments**, pick the latest one and choose **Redeploy** (or push a commit).

### If the project ever has to be created again

1. On vercel.com: **Add New → Project → Import Git Repository**, and pick `grv-io/jallog`.
2. Leave the framework preset as Next.js and the build settings as they are.
3. Add `GEMINI_API_KEY` under Environment Variables.
4. Deploy.
5. If the key was added or changed after the first deployment, **Redeploy**.

### What to check after a deployment

1. <https://jallog.vercel.app/api/extract> answers `{"ready":true}`. `{"ready":false}` means the key is missing or the model service refused it.
2. The welcome screen loads. **Open the 3-shift sample plant** shows 88 of 90 shifts recorded; **Switch to the daily-register sample** shows 45 of 46 entries.
3. **Capture → "Clean, typical 3-shift STP page"**: the first line under "Check the reading" says "read from page-1.jpg by gemini-…" and gives the "Sample page check" count. If it says "from an earlier reading", live reading is not working or the allowance is used up.
4. Optional, one model call: `node scripts/eval-extract.mjs https://jallog.vercel.app --pages page-1.jpg`. All four pages cost four calls of the visitor's daily ten.
5. **Report → Print / save PDF** opens the browser's print dialog with the report in it.
6. The README on GitHub renders, and its links to the live app and to `docs/` open.

What has been checked on the deployed site so far: the four generated sample pages were read at 404 of 412 written cells (98.1%), with nothing invented and nothing wrong returned as sure; the 8 misses were one flow column on sample page 3, left unmapped by a lighter fallback model while the main model was busy; pages took 11 to 38 seconds. The site answers `{"ready":true}`, and the upload route accepts a request from its own origin and refuses one from another origin with a 403.

### Limits to remember on the deployed site

- The route allows itself 60 seconds per page and answers within 55.
- Allowances are counted in memory per server instance, so they reset when an instance restarts and each instance keeps its own count.
- With a free key, each model has a small daily request limit of its own (the API reported 20 for `gemini-3.5-flash` on 4 October 2026). When the main model is out of quota or busy, a fallback model answers, and it may read a page less completely.

---

## Before pressing submit

- [ ] Latest commit pushed; deployment ready; checks in part 4 done.
- [ ] README figures match this file (tests: 757; accuracy: 404 / 412, 166 / 167).
- [ ] Video recorded on the production address, under 2 minutes, with any cut in reading time marked.
- [ ] Submission text pasted; the "nobody at a plant has used it yet" sentence is still true, or has been replaced.
- [ ] No real register scan, no plant name, no API key in the repository or the video.
