# JalLog: sourced research (4 Oct 2026)

Every claim has a URL. Anything I could not confirm from a primary or reputable source is under **Unverified** at the end.

## 1. Is the problem real?

### 1a. Logbooks are a legal/consent requirement
- **RSPCB (Rajasthan) consent to operate, M/s Nirma Ltd, Pali, order 04/10/2017**: "separate energy meter & hour meter shall be provided and maintained at all the air pollution control measures & ETP/STP and daily record of running hours of pollution control measures and energy consumption shall be maintained in log book." Also: "suitable flow measuring devices/ meters on the inlet and outlet of sewage treatment plant shall be maintained. Daily record of domestic waste water generation and its treatment and utilization shall be maintained." https://environmentclearance.nic.in/writereaddata/Form-2/General1/01102018JYM4P94OValidCTO.pdf (industrial unit, not an apartment; I found no RSPCB apartment CTO text).
- **HSPCB (Haryana) consent procedure**, required with the CTO application: "Copy of logbook for last 03 months maintained for operation of ETP/STP/APCM for the record of energy and chemical consumption, quantity of effluent at inlet and outlet of ETP/STP supported with readings of magnetic flow meters alongwith quantity of treated effluent recycled/reused..., mode of disposal." https://hspcb.org.in/uploads/pages/cp_66ab4d8e8b6b5.pdf
- **KSPCB STP Guide** (Karnataka): "Prepare and maintain an operating log book for all activities in the STP" and "Periodically check and validate all log books". https://prod-qt-images.s3.amazonaws.com/indiawaterportal/import/sites/default/files/iwp2/The_STP__guide__Design__operation__and__maintainance__Published__by__the__Karnataka__State__Pollution__Control__Board.pdf
- **CPHEEO O&M Manual Part B, ch. 7**: "Two separate records shall be kept; one for public consumption in respect of statutory discharge standards and the other for in-house plant control." https://sswm.info/sites/default/files/reference_attachments/CPHEEO%202012%20Manual%20on%20sewerage%20and%20sewage%20treatment.%20Part%20B%20Operation%20and%20Maintenance.pdf
- Karnataka minister (reported 1 Sep 2026): officers to "conduct a survey of buildings with more than 80 units and verify their STP operation records." https://newsfirstprime.com/karnataka/15-days-to-fix-stps-karnataka-warns-apartments-of-criminal-action-over-sewage-pollution-12479351

### 1b. Plants are non-compliant / non-functional
- **CPCB National Inventory of STPs (2020-21, report Sep 2021)**: 1,631 STPs (incl. proposed), 36,668 MLD; 1,093 operational, 102 non-operational, 274 under construction, 162 proposed. Compliance status known for 900 of the operational plants; only **578 (about 12,200 MLD) comply** with consented norms. Sewage generated 72,368 MLD; capacity actually utilised 20,235 MLD. https://cpcb.gov.in/openpdffile.php?id=UmVwb3J0RmlsZXMvMTIyOF8xNjE1MTk2MzIyX21lZGlhcGhvdG85NTY0LnBkZg%3D%3D
- **Rajasthan (same inventory, s.4.28)**: 140 STPs, installed 1,086 MLD vs 3,185 MLD generated, operational 783 MLD, "capacity of complied STPs is only 224 MLD". Same URL.
- **Jaipur**: NGT Central Zone Bench (Captain Satyender Kumar Singh v. State of Rajasthan, 8 Apr 2024) directed JDA to upgrade a 30 MLD STP to meet the 30.04.2019 parameters (BOD 10, TSS 20) and pay Rs 2 crore compensation. https://indiankanoon.org/doc/111470088/
- **Bengaluru apartments**: 2,200+ complexes have KSPCB consent for STPs; about 600 are "operational"; KSPCB admits over 50% of "operational" ones may not meet standards; KSPCB staff "only seem to pay visits to the really big apartment complexes". https://citizenmatters.in/bengaluru-apartments-stp-sewage-treatment/ . 500+ apartments violated norms (Sep 2026): https://newsfirstprime.com/karnataka/15-days-to-fix-stps-karnataka-warns-apartments-of-criminal-action-over-sewage-pollution-12479351
- **Gurugram** (GMDA, 18 Sep 2026): 175 STPs mandated north + 179 south; 33 and 8 non-operational; about Rs 14 crore penalties, Rs 4 crore recovered. https://www.tribuneindia.com/news/delhi/gmda-warns-of-disconnections-over-faulty-sewage-plants

### 1c. Fabricated / tampered data
- **CPCB Caution Notice, 8 May 2018**: industries with OCEMS "are hereby cautioned against any kind of tampering because CPCB has started checking OCEMS tampering through remote calibration facility." https://cpcb.gov.in/upload/thrust-area/notice_data_tampering_08.05.2018.pdf
- **CETP Vapi joint inspection (CPCB+GPCB, Oct-Dec 2021 quarter)**: OCEMS outlet COD 234 / BOD 23 ppm; OCEMS and lab results "not comparable"; "OCEMS... needs proper calibration" (a discrepancy, not proven fraud). https://cpcb.gov.in/NGT/11-REP-JOINTINSPECT-CETP-VAPI.pdf
- **Gujarat field experiment (QJE 2013)**: status-quo audit reports were "largely corrupted"; 29% of audits falsely reported readings as below the standard; 73% of plants' reported SPM sat in the 75-100% band just under the limit. Covers industrial air and water audits, not STP logbooks. https://www.povertyactionlab.org/sites/default/files/research-paper/156_321_QJE_2013_Truth_Telling_Third_Party_Audits.pdf
- Usable signature for the rule engine: values bunching just under limits (the pattern documented above).
- The OCEMS "double entry" allegation is anonymous only (see Unverified).

### 1d. How logbooks are kept
- Formats found are paper/columnar registers with operator signature and meter readings (section 3). The pollution-board format carries the note: "In case of meter change it should be clearly mentioned in remarks & old meter should be kept for the verification of the reading."
- Verification at consent time is by checking a 3-month logbook copy (Haryana, above). I found no source describing how often logbooks are reviewed in practice.

## 2. Discharge standards (STP, treated sewage)

| Parameter | EP Rules old general std (inland surface water) | MoEFCC Oct 2017 (G.S.R. 1265) | NGT 30.04.2019 (nationwide) |
|---|---|---|---|
| pH | 5.5-9.0 | 6.5-9.0 (secondary source) | 5.5-9.0 (committee table); CPCB chairman direction quoted 6.5-9 |
| BOD mg/L | 30 (3 days at 27 C) | <30; <20 metro cities | 10 |
| COD mg/L | 250 | no limit | 50 |
| TSS mg/L | 100 | <100; <50 metro cities | 20 |
| Total N mg/L | 100 | no limit | 10 |
| NH4-N mg/L | 50 | no limit | 5 (CPCB direction text) |
| Total P | no limit | no limit | 1.0 (for discharge to ponds/lakes) |
| Fecal coliform MPN/100 mL | no limit | <1000 | 100 (most probable number; text also cites 230, the CPHEEO value) |

Sources: NGT order text (table of old/draft/2017 norms, adopted table, paras 3, 7, 9, 14): https://www.greentribunal.gov.in/gen_pdf_test.php?filepath=L25ndF9kb2N1bWVudHMvRWZpbGluZ19kb2N1bWVudHMvbmd0ZG9jL2Nhc2Vkb2MvMDcwMTEwMjAwNDg2MjAxOC8wNC8wMS8yNS8wNF8yNV8wMDFfMTU5MTEwNzI5NjQ5Mi5wZGY%3D . Schedule VI pH 5.5-9.0, SS 100 and the "BOD (3 days at 27oC)" footnote: https://cpcb.gov.in/generalstandards.pdf . 2017 pH: https://www.studiomatrx.org/guides/cpcb-guidelines-stp (secondary). The Schedule VI BOD 30 / COD 250 values are as listed in the "Old Norms 1986" column of the NGT order; the Schedule VI PDF text extracted badly.

**Which applies to a new Jaipur STP?** NGT para 14: the metro-grade values "will also apply to rest of the country", to new and existing STPs "without any delay"; SPCBs "may make these norms more stringent". The 2024 NGT Bhopal order applied BOD 10 / TSS 20 to a Jaipur STP, so the 2019 values are the safest assumption. I could not confirm that MoEFCC re-notified them or what an individual RSPCB consent states. **Unclear; the consent letter governs.** Make limits configurable per plant.

## 3. What a real logbook looks like

| Document | Columns / content | Frequency |
|---|---|---|
| Pollution-board "Logbook format of Effluent Treatment Plant" (chocmms.nic.in, a state OCMMS portal, appears to be Chhattisgarh): https://chocmms.nic.in/SPCB_DOCUMENTS/LogBookFormat.pdf | Date; Time From/To; final reading inlet flow meter; final reading outlet flow meter; initial and final electricity meter; quantity of chemicals used; quantity of ETP sludge generated; signature of operator; remarks | per entry/day |
| Daily ETP and STP Performance and Operation Record, Annexures 1 and 2 (industry SOP): https://pharmabeginers.com/sop-and-formats-for-etp-stp/ | Total effluent treated; power consumption; chemicals (alum, caustic, polyelectrolyte, urea, DAP, hypochlorite); running hours; sludge; pH inlet/outlet; blower record; flow meter FMR/IMR/difference per shift A/B/C; shift manpower | pH every 2 hours; flow per shift A/B/C; daily totals |
| CPHEEO Manual Part B, Tables 7.2-7.4 (recommended tests), link in 1a | Daily: temperature, pH, alkalinity, BOD, COD, TSS, VSS, residual chlorine, MLSS, MLVSS, DO, SV30, SVI, ammonia, ortho-P, sulphide, by sampling point (raw, primary outlet, aeration tank, secondary outlet, outfall, sludge). Weekly adds filtered BOD/COD, microscopy, fecal coliform | daily / weekly / monthly-biannual |
| Hospital STP 3-shift log (Scribd; I could only read a summary): https://www.scribd.com/document/583890193/Blank-Page | meter readings, equipment use, chemicals, treated water quantity, pH, operator signature per shift | 3 shifts |

Schema takeaway: flow-meter and kWh readings, chemical quantity, running hours, pH, blower status and operator signature appear in every format. Lab parameters (BOD/COD/TSS/MLSS/SV30/DO) appear in plant-control sheets but are absent from the minimal board format.

### 3a. A real register, read during the build (4 Oct 2026)
- A published register from a small hospital STP was used to test reading. Its scans, its values and the plant's name are deliberately not in this repository.
- Layout: one row per day, no shift letters, no lab values. Columns: date; inlet and outlet flow meter readings (cumulative); plant start and close time; lime, alum and chlorine dosed (grams or kilograms); energy meter start and close readings; sludge (kg); operator signature. This matches the pollution-board format in the first row of the table above, not the lab-style sheet.
- Consequence for the product: seven parameters were added (inlet and outlet meter readings, run hours, lime, alum, chlorine, sludge), and a plant can be set to one row a day.
- What the rule engine raises on one transcribed page: inlet and outlet meter readings identical on all 14 rows. That is a point to verify (one meter, or one column written from the other), not a finding.
- Reading accuracy on two pages: 166 of 167 readable cells correct, one misread returned with high confidence; 20 further cells were excluded because the person writing down the true values could not read them. Measured with `scripts/eval-extract.mjs --truth` against a truth file kept outside the repository.
- Not established: how typical this one register is of small-plant registers in general.

## 4. Monthly / annual submissions
- **Form V (Environmental Statement)**: annual, by 30 September for the year ending 31 March, under Rule 14 of the EP Rules 1986. Parts A-I: general info; water and raw-material consumption; pollution discharged (water and air); hazardous waste; solid waste; abatement impact. ETP logbooks feed Part C (treated effluent m3/day, BOD/COD/TSS, pollutant load). https://ehssaral.com/blog/form-5-environmental-statement-guide (secondary; I did not fetch the primary form). Applies to industries; not confirmed for apartment STPs.
- **Consent application/renewal**: 3-month logbook copy plus inlet/outlet lab analysis reports (HSPCB link in 1a).
- I found **no single statutory "monthly STP report" format**. The monthly report is a JalLog value-add, not a mandated form.

## 5. Existing products
- **AquaSTP** (Android app): "IoT Platform for Smart STP & ETP Compliance"; operators submit daily logs and checklists in-app (search snippet; page not fully readable). https://play.google.com/store/apps/details?id=com.ziac.aquastpapp . Price unknown. Digital entry, not paper-photo.
- **DigitalPaani**: IoT plus algorithms for STP/ETP/WTP; FY25 revenue Rs 6.4 Cr; about $3.5M raised, latest round 8 Sep 2026. Enterprise focus. Price not public. No evidence of paper-photo OCR. https://inc42.com/company/digitalpaani/
- **EHSSaral**: compliance tracker; free for single-site, paid for multi-site; its own blog says SME platforms run Rs 1.5-5 lakh/year. Fetched page does not mention an STP logbook module or OCR. https://ehssaral.com/blog/free-environmental-compliance-software-india
- **Online monitoring vendors**: IndiaMART listings, remote ETP/STP monitoring systems about Rs 3.5-14 lakh (sensor hardware). https://www.indiamart.com/proddetail/etp-stp-remote-monitoring-systems-13748179973.html
- **Fluid Robotics**: pipeline/sewer robotics and analytics, not a logbook tool. https://yourstory.com/companies/fluid-robotics
- Honest read: I found no product doing paper-logbook photo extraction, but digital-logbook apps and IoT players exist, and I did not check every vendor.

## 6. Market numbers
- 1,631 STPs / 1,093 operational (CPCB 2021): link in 1b. This is a municipal-scale inventory; small and apartment STPs are not visible in it.
- Bengaluru: 2,200+ apartment complexes with STP consent, about 600 operational, about 100 MLD: https://citizenmatters.in/bengaluru-apartments-stp-sewage-treatment/
- Gurugram: 354 STPs mandated (175 + 179): Tribune link in 1b.
- RIICO: 390 industrial areas, 42,300+ units in production (RIICO profile, c. FY21; Wikipedia says 360 areas): https://environment.rajasthan.gov.in/content/dam/industries/pdf/riico/aboutriico/riicoprofile/RIICO-Profile.pdf
- OCEMS mandated for the 17 GPI categories: https://spans.co.in/knowledge/cpcb-ocems-guidelines-industries/ (secondary).

## 7. Process facts for the rule engine
- **DO**: "effluent end of the aerator should have a dissolved oxygen level of at least 1.0 mg/L"; operating DO "usually 1 to 2 mg/l". CPHEEO Part B (link 1a).
- **SVI** (CPHEEO Table 4.1): <50 pin floc; 50-100 good; 100-150 filament growth; 150-200 bulking at high flows; 200-300 bulking; >300 severe. SVI = SV30 (mL/L) x 1000 / MLSS (mg/L). CPHEEO Part B.
- **MLSS / SV30 (KSPCB STP Guide)**: design MLSS 3,500-4,000 mg/L; operate within a band such as 3,500-4,500 mg/L; field proxy SV30 350-450 mL/L assumes SVI about 100. Link in 1a. Applies to conventional ASP; SBR/MBBR/MBR differ.
- **BOD timing**: the NGT order quotes the expert committee: COD takes "5 Hours as against 5 days at 20oC or 3 days at 27oC for BOD (Sawyer & Mccarty)". Schedule VI footnote: BOD 5 days at 20 C may be read as BOD 3 days at 27 C (https://cpcb.gov.in/generalstandards.pdf). IS 3025 Part 44 itself was not fetched. Model BOD as a lagged lab value, not a per-shift reading.
- Caveat: CPHEEO Table 7.2 lists BOD/COD among "daily" plant-control tests, so a daily lab entry exists in the norm even though the result lags.

## Unverified (not stated as fact)
- Supreme Court upholding the NGT 2019 STP standards in June 2021 (one secondary summary only; order not found).
- Whether MoEFCC re-notified the 2019 values; what RSPCB's apartment-STP consent says (a susbio.in page lists pH 6.5-8.5, BOD 10, COD 50, TSS 10, TN 5, FC 100 for Rajasthan, with no primary source).
- "80% of Bengaluru apartment STPs fail standards" and "only 10% meet all": search snippets only; the figure I fetched is Citizen Matters' "over 50%".
- Anonymous industry claim of OCEMS "double entries" and "supervisors bribed or beaten up": https://scroll.in/article/991241/can-data-prove-to-be-the-nemesis-of-indias-polluting-industries (unnamed sources, no case).
- Any Indian case of a back-filled or fabricated STP logbook specifically. I found none. US cases exist, e.g. Port Leyden NY (readings not taken, paperwork pre-filled): https://www.wwnytv.com/2023/04/28/alleged-false-sewage-readings-could-have-cost-taxpayers-port-leydens-mayor-says/ , but are not Indian.
- Prices for DigitalPaani and AquaSTP; AquaSTP features beyond its store blurb.
- Count of industries with ETPs under consent ("2.5 lakh industries need consent" appeared only in an unfetched summary); number of apartment STPs in Jaipur/Rajasthan.
- Whether a logbook condition appears in RSPCB apartment/hospital consents (only an industrial consent confirmed).
- Which board owns the chocmms.nic.in format (assumed Chhattisgarh).
