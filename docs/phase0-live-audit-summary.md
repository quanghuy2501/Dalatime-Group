# Phase 0 Live Audit Summary

Service account access is working.

## Service account
- Email: `onicorn-dashboard-sync@core-silicon-312512.iam.gserviceaccount.com`
- Local key path: `/Users/quanghuy/.openclaw/secrets/onicorn-dashboard-service-account.json`

## Live counts
- Employee folder files: 36
- Employee spreadsheets audited: 36
- Customer report folder files: 141
- Customer report spreadsheets audited: 141
- Employee errors: 0
- Customer report errors: 0

## Master live counts
- `1. KHACH HANG`: 144 data rows
- `2. NHAN SU`: 995 data rows
- `3. CHANNEL`: 153 data rows
- `4. LIST BRAND`: 169 data rows
- `RAW_DATA`: 1796 rows, 26 cols
- `NORMALIZED`: 1796 rows, 26 cols
- `SYNC_LOG`: 593 rows

## Notes
- The old extracted CSV snapshot was stale. Live Master has 26 cols as expected.
- Google Sheets API quota is 60 read requests/min/user, so all live jobs must be rate-limited and resumable.
