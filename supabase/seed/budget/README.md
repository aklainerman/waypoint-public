# Budget seed data

Public DoD FY27 budget data + Hill data, exported from a working Waypoint
production deployment. Apply these files **in lexicographic order** via
Supabase Studio's SQL editor, `psql`, or the Supabase MCP's `execute_sql`.

Each `INSERT` uses dollar-quoting (`$$...$$`) so multi-line narrative text
with embedded apostrophes and newlines is safe, and each carries
`ON CONFLICT DO NOTHING` so re-applying the seed is a no-op.

## Apply order

Large tables are pre-chunked to fit Supabase MCP `execute_sql` payload
limits (~2 MB per call). A simple `ls *.sql | sort` produces the correct
apply order for both single-file and chunked layouts.

| # | Table | Rows | Files | Total size |
|---|-------|------|-------|------------|
| 01 | `budget_appropriations` | 205 | `01_budget_appropriations.sql` | 46.2 KB |
| 02 | `budget_orgs` | 201 | `02_budget_orgs.sql` | 49.6 KB |
| 03 | `budget_pes` | 2,143 | `03_budget_pes_01.sql` ... `03_budget_pes_06.sql` | 8.57 MB |
| 04 | `budget_om_sags` | 389 | `04_budget_om_sags.sql` | 1.27 MB |
| 05 | `budget_topline_lines` | 51 | `05_budget_topline_lines.sql` | 60.3 KB |
| 06 | `budget_projects` | 2,302 | `06_budget_projects_01.sql` ... `06_budget_projects_03.sql` | 4.43 MB |
| 07 | `pe_budget_years` | 2,927 | `07_pe_budget_years.sql` | 1.82 MB |
| 08 | `procurement_line_years` | 2,044 | `08_procurement_line_years_01.sql` ... `08_procurement_line_years_08.sql` | 11.52 MB |
| 09 | `om_activity_years` | 2,107 | `09_om_activity_years_01.sql` ... `09_om_activity_years_06.sql` | 8.97 MB |
| 10 | `pe_narratives` | 1,753 | `10_pe_narratives_01.sql` ... `10_pe_narratives_65.sql` | 94.15 MB |
| 11 | `om_sag_narratives` | 778 | `11_om_sag_narratives.sql` | 1.87 MB |
| 12 | `proc_line_narratives` | 1,717 | `12_proc_line_narratives_01.sql` ... `12_proc_line_narratives_13.sql` | 17.99 MB |
| 13 | `pe_title_overrides` | 50 | `13_pe_title_overrides.sql` | 18.1 KB |
| 14 | `pe_office_links` | 6,911 | `14_pe_office_links.sql` | 1.45 MB |
| 15 | `sag_office_links` | 699 | `15_sag_office_links.sql` | 156.2 KB |
| 16 | `hill_members` | 536 | `16_hill_members.sql` | 431.2 KB |
| 17 | `hill_committees` | 230 | `17_hill_committees.sql` | 102.9 KB |
| 18 | `hill_committee_memberships` | 3,879 | `18_hill_committee_memberships.sql` | 663.4 KB |

## How to apply

### Easiest: drive with Claude (recommended)

Connect the Supabase MCP to your Claude account, then ask Claude to
apply the seeds via the `setup-waypoint` skill. The skill applies each
file from `01_budget_appropriations.sql` through
`18_hill_committee_memberships.sql` in lexicographic order via
`execute_sql`. See [`docs/CLAUDE_SETUP.md`](../../../docs/CLAUDE_SETUP.md).

### Manual: psql

Required if you're driving the install yourself. Supabase Studio's SQL
editor can't handle files over ~1 MB, so the chunked tables need `psql`.

```bash
# Get DB URL from Supabase: Settings -> Database -> Connection string
export DB_URL="postgresql://postgres:<password>@db.<your-project-ref>.supabase.co:5432/postgres"
for f in $(ls -1 *.sql | sort); do
  echo "Applying $f..."
  psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

On Windows PowerShell:

```powershell
$env:PGPASSWORD = "<your db password>"
$DB_URL = "postgresql://postgres@db.<your-project-ref>.supabase.co:5432/postgres"
Get-ChildItem *.sql | Sort-Object Name | ForEach-Object {
  Write-Host "Applying $($_.Name)..."
  psql $DB_URL -v ON_ERROR_STOP=1 -f $_.FullName
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED on $($_.Name)"; break }
}
```

## PDF deep-links

See [`PDF_MANIFEST.md`](PDF_MANIFEST.md) for the source PDFs the Budget
tab's "Source" buttons deep-link into. Forkers who want those links to
resolve should follow the 4-step setup in the manifest. Without the
PDFs uploaded, only the Source buttons 404 -- the rest of the Budget
tab works fine.
