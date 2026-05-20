# PDF deep-link manifest

Waypoint's Budget tab includes "Source" buttons that deep-link into
specific pages of DoD budget justification books ("J-Books"). These
default to 404 because the app expects PDFs hosted in your Supabase
Storage bucket named `budget-jbooks`. To enable:

1. Download each PDF listed below from
   [comptroller.defense.gov/Budget-Materials/](https://comptroller.defense.gov/Budget-Materials/).
2. Create a Supabase Storage bucket named `budget-jbooks` with
   public-read access on your project.
3. Upload each PDF, preserving the exact filename from the table
   below (the app builds storage URLs by exact match on this string).
4. Reload the Budget tab. Source buttons will resolve.

The rest of the app works fine without these -- only Source buttons
404 until the bucket is populated.

## Required PDFs

Total: **219** distinct PDFs referenced across the seed data.

| Filename |
|----------|
| `Budget J-Books/FY26/Army/RDTE - Vol 1 - Budget Activity 1.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 1 - Budget Activity 2.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 1 - Budget Activity 3.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 2 - Budget Activity 4A.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 2 - Budget Activity 4B.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 3 - Budget Activity 5A.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 3 - Budget Activity 5B.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 3 - Budget Activity 5C.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 3 - Budget Activity 5D.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 4 - Budget Activity 6.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 4 - Budget Activity 7.pdf` |
| `Budget J-Books/FY26/Army/RDTE - Vol 4 - Budget Activity 8.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_DCMA_PB_2026.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_DISA_PB_2026.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_DLA_PB_2026.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_DTRA_PB_2026.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_SOCOM_PB_2026.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.pdf` |
| `Budget J-Books/FY26/Defense Wide/RDTE_Vol2_MDA_RDTE_PB26_Justification_Book.pdf` |
| `Budget J-Books/FY26/Navy/RDTEN_BA1-3_Book.pdf` |
| `Budget J-Books/FY26/Navy/RDTEN_BA4_Book.pdf` |
| `Budget J-Books/FY26/Navy/RDTEN_BA5_Book.pdf` |
| `Budget J-Books/FY26/Navy/RDTEN_BA6_Book.pdf` |
| `Budget J-Books/FY26/Remaining/Counter-Islamic State of Iraq and Syria Train and Equip Fund.pdf` |
| `Budget J-Books/FY26/Remaining/FY2026_CTEF_J-Book.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Aircraft Procurement Vol I.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Aircraft Procurement Vol II.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Ammunition Procurement.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Missile Procurement.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Other Procurement.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Research and Development Test and Evaluation Vol I.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Research and Development Test and Evaluation Vol II.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Research and Development Test and Evaluation Vol III.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Air Force Research and Development Test and Evaluation Vol IV.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Space Force Procurement.pdf` |
| `Budget J-Books/FY26/USAF/FY26 Space Force Research and Development Test and Evaluation.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Aircraft  Ammunition Procurement.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Aircraft  Missile Procurement.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Aircraft Procurement Volume I.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Aircraft Procurement Volume II.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Other Procurement.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Research, Development, Test & Evaluation  Volume I.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Research, Development, Test & Evaluation  Volume II.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Research, Development, Test & Evaluation  Volume III.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Research, Development, Test & Evaluation  Volume IV.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Air Force Space Procurement.pdf` |
| `Budget J-Books/FY27/Air Force/FY27 Space Force Research, Development, Test & Evaluation.pdf` |
| `Budget J-Books/FY27/Army/Aircraft_Procurement_Army.pdf` |
| `Budget J-Books/FY27/Army/Counter-Islamic State of Iraq and Syria Train and Equip Fund.pdf` |
| `Budget J-Books/FY27/Army/Missile Procurement Army.pdf` |
| `Budget J-Books/FY27/Army/Other Procurement - BA1 - Tactical & Support Vehicles.pdf` |
| `Budget J-Books/FY27/Army/Other Procurement - BA3 & 4 - Other Support Equipment & Initial Spares.pdf` |
| `Budget J-Books/FY27/Army/Other_Procurement - BA2 - Communications & Electronics.pdf` |
| `Budget J-Books/FY27/Army/Procurement_of_Ammunition.pdf` |
| `Budget J-Books/FY27/Army/Procurement_of_Weapons_and_Tracked_Combat_Vehicles.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 1 - Budget Activity 1.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 1 - Budget Activity 2.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 1 - Budget Activity 3.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 2 - Budget Activity 4A.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 2 - Budget Activity 4B.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 3 - Budget Activity 5A.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 3 - Budget Activity 5B.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 3 - Budget Activity 5D.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 4 - Budget Activity 6.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 4 - Budget Activity 7.pdf` |
| `Budget J-Books/FY27/Army/RDTE - Vol 4 - Budget Activity 8.pdf` |
| `Budget J-Books/FY27/Army/RDTEVol3BudgetActivity5C.pdf` |
| `Budget J-Books/FY27/DW/RDTE_CBDP_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_CYBERCOM_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_DCAA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_DCSA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_DHRA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_DSCA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_DTIC_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_OSW_PB_2027.pdf` |
| `Budget J-Books/FY27/DW/RDTE_Vol1_DARPA_MasterJustificationBook_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_CBDP_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_CYBERCOM_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DCSA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DHRA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DISA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DLA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DMACT_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DODEA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DPAA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_DTRA_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_MDA_VOL2B_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_OSD_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_SOCOM_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_TJS_PB_2027.pdf` |
| `Budget J-Books/FY27/DW_Procurement/PROC_WHS_PB_2027.pdf` |
| `Budget J-Books/FY27/MHS/MHS_PB27_J-Book-Vol1-COMP_PSCP.pdf` |
| `Budget J-Books/FY27/Navy/APN_BA1-4_Book.pdf` |
| `Budget J-Books/FY27/Navy/APN_BA5_Book.pdf` |
| `Budget J-Books/FY27/Navy/APN_BA6-7_Book.pdf` |
| `Budget J-Books/FY27/Navy/OPN_BA1_Book.pdf` |
| `Budget J-Books/FY27/Navy/OPN_BA2_Book.pdf` |
| `Budget J-Books/FY27/Navy/OPN_BA3_Book.pdf` |
| `Budget J-Books/FY27/Navy/OPN_BA4_Book.pdf` |
| `Budget J-Books/FY27/Navy/OPN_BA5-8_Book.pdf` |
| `Budget J-Books/FY27/Navy/PANMC_Book.pdf` |
| `Budget J-Books/FY27/Navy/PMC_Book.pdf` |
| `Budget J-Books/FY27/Navy/PMC_Book.txt` |
| `Budget J-Books/FY27/Navy/RDTEN_BA1-3_Book.pdf` |
| `Budget J-Books/FY27/Navy/RDTEN_BA4_Book.pdf` |
| `Budget J-Books/FY27/Navy/RDTEN_BA5_Book.pdf` |
| `Budget J-Books/FY27/Navy/RDTEN_BA6_Book.pdf` |
| `Budget J-Books/FY27/Navy/RDTEN_BA7-8_Book.pdf` |
| `Budget J-Books/FY27/Navy/SCN_Book.pdf` |
| `Budget J-Books/FY27/Navy/SCN_Book.txt` |
| `Budget J-Books/FY27/Navy/WPN_Book.pdf` |
| `Budget J-Books/FY27/Remaining/DoW_FY2027_Mandatory_Funding_Overview.txt` |
| `Budget J-Books/FY27/Remaining/FY2027_p1.pdf` |
| `Budget J-Books/FY27/Remaining/FY2027_p1.txt` |
| `Budget J-Books/FY27/Remaining/FY2027_r1.pdf` |
| `Budget J-Books/FY27/Remaining/FY2027_r1.txt` |
| `Budget J-Books/FY27/Remaining/RDTE_DCMA_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_DISA_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_DLA_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_DTRA_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_OTE_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_SOCOM_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_TJS_PB_2027.pdf` |
| `Budget J-Books/FY27/Remaining/RDTE_Vol2_MDA_RDTE_PB27_Justification_Book.pdf` |
| `FY26 Air Force Research and Development Test and Evaluation Vol I.pdf` |
| `FY26 Air Force Research and Development Test and Evaluation Vol II.pdf` |
| `FY26 Air Force Research and Development Test and Evaluation Vol III.pdf` |
| `FY26 Air Force Research and Development Test and Evaluation Vol IV.pdf` |
| `FY26 Space Force Research and Development Test and Evaluation.pdf` |
| `O&M/FY26/Air Force/FY26 Air Force Operations and Maintenance Vol I.pdf` |
| `O&M/FY26/Air Force/FY26 Air Force Reserve Operations and Maintenance Vol I.pdf` |
| `O&M/FY26/Air Force/FY26 Air National Guard Operation and Maintenance Vol I.pdf` |
| `O&M/FY26/Air Force/FY26 Space Force Operations and Maintenance Vol I.pdf` |
| `O&M/FY26/Army/National Guard Army Operation and Maintenance.pdf` |
| `O&M/FY26/Army/Regular Army Operation and Maintenance Volume-1.pdf` |
| `O&M/FY26/Army/Reserve Army Operation and Maintenance.pdf` |
| `O&M/FY26/DW/DMA_OP-5.pdf` |
| `O&M/FY26/DW/O-1_Summary_(Part_1).pdf` |
| `O&M/FY26/DW/OM_Volume1_Part1.pdf` |
| `O&M/FY26/DW/OM_Volume1_Part_2.pdf` |
| `O&M/FY26/DW/TJS_OP-5.pdf` |
| `O&M/FY26/Navy/OMMCR_Book.pdf` |
| `O&M/FY26/Navy/OMMC_Book.pdf` |
| `O&M/FY26/Navy/OMNR_Book.pdf` |
| `O&M/FY26/Navy/OMN_Book.pdf` |
| `O&M/FY27/Air Force/FY27 Air Force Operation & Maintenance Volume I.pdf` |
| `O&M/FY27/Air Force/FY27 Air Force Reserve Operation & Maintenance Volume I.pdf` |
| `O&M/FY27/Air Force/FY27 Air National Guard Operation & Maintenance Volume II.pdf` |
| `O&M/FY27/Air Force/FY27 Space Force Operation & Maintenance Volume I.pdf` |
| `O&M/FY27/Army/National Guard Army Operation and Maintenance.pdf` |
| `O&M/FY27/Army/Regular Army Operation and Maintenance Volume 1.pdf` |
| `O&M/FY27/Army/Reserve Army Operation and Maintenance.pdf` |
| `O&M/FY27/DW/Vol1_Part1/CMP_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DAU_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DCAA_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DCAA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DCMA_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DCMA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DCSA_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DCSA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DHRA_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DHRA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DISA_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DISA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DLA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DLSA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DPAA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DSCA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DTRA_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DTRA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DTSA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DWIA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/DoWDE_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/MDA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/OLDCC_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/OSW_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/OSW_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/PSYOP_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/SOCOM_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/TJS_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/USCYBERCOM_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part1/WHS_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/CAAF_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/CTR_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/DAWDA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/OHDACA_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/OIG_Cyber_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/OIG_OP-5.pdf` |
| `O&M/FY27/DW/Vol1_Part2/SISC_OP-5.pdf` |
| `O&M/FY27/FY2027_o1.pdf` |
| `O&M/FY27/Navy/OMMCR_Book.pdf` |
| `O&M/FY27/Navy/OMMC_Book.pdf` |
| `O&M/FY27/Navy/OMNR_Book.pdf` |
| `O&M/FY27/Navy/OMN_Book.pdf` |
| `RDTE - Vol 1 - Budget Activity 1.pdf` |
| `RDTE - Vol 1 - Budget Activity 2.pdf` |
| `RDTE - Vol 1 - Budget Activity 3.pdf` |
| `RDTE - Vol 2 - Budget Activity 4A.pdf` |
| `RDTE - Vol 2 - Budget Activity 4B.pdf` |
| `RDTE - Vol 3 - Budget Activity 5A.pdf` |
| `RDTE - Vol 3 - Budget Activity 5B.pdf` |
| `RDTE - Vol 3 - Budget Activity 5C.pdf` |
| `RDTE - Vol 3 - Budget Activity 5D.pdf` |
| `RDTE - Vol 4 - Budget Activity 6.pdf` |
| `RDTE - Vol 4 - Budget Activity 7.pdf` |
| `RDTE - Vol 4 - Budget Activity 8.pdf` |
| `RDTEN_BA1-3_Book.pdf` |
| `RDTEN_BA4_Book.pdf` |
| `RDTEN_BA5_Book.pdf` |
| `RDTEN_BA6_Book.pdf` |
| `RDTE_DCMA_PB_2026.pdf` |
| `RDTE_DISA_PB_2026.pdf` |
| `RDTE_DLA_PB_2026.pdf` |
| `RDTE_DTRA_PB_2026.pdf` |
| `RDTE_OSD_PB_2026.pdf` |
| `RDTE_OTE_PB_2026.pdf` |
| `RDTE_SOCOM_PB_2026.pdf` |
| `RDTE_Vol1_DARPA_MasterJustificationBook_PB_2026.pdf` |
| `RDTE_Vol2_MDA_RDTE_PB26_Justification_Book.pdf` |

## Locating each PDF on comptroller.defense.gov

Filenames follow the patterns Waypoint extracted them from
(typically `<volume>_<service>_<book>.pdf`). To find a given file:

1. Visit <https://comptroller.defense.gov/Budget-Materials/>.
2. Filter to the fiscal year matching your seed data.
3. Drill into the appropriate volume (RDT&E, Procurement, O&M)
   and service (Army, Navy, Air Force, Defense-Wide).
4. Save the PDF preserving the manifest's filename.
