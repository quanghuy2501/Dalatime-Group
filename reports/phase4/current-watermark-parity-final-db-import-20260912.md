# Current-watermark parity

- Verdict: **pass**
- Run ID: `e60edc95-2afd-4bf7-ba2f-8a97c37d64c5`
- Watermark: `{"drive_modified_time":"2026-09-11T09:55:59.098Z","captured_at":"2026-09-11T15:22:06.816895Z","run_id":"ee554ffc-519d-4e58-8228-1bcbbaa89d82"}`
- Read-only: **true** (no Google or DB writes)
- Latency: master 792 ms; DB SELECT 3803 ms; total 4811 ms

## Counts

| Dataset | Master | DB | Missing | Extra |
|---|---:|---:|---:|---:|
| clients | 145 | 145 | 0 | 0 |
| staff | 36 | 36 | 0 | 0 |
| channels | 152 | 152 | 0 | 0 |
| brands | 170 | 170 | 0 | 0 |
| raw_data | 5019 | 5019 | 0 | 0 |
| normalized | 65170 | 65170 | 0 | 0 |

## Exact differences

### clients

Missing: `[]`

Extra: `[]`

### staff

Missing: `[]`

Extra: `[]`

### channels

Missing: `[]`

Extra: `[]`

### brands

Missing: `[]`

Extra: `[]`

### raw_data

Missing: `[]`

Extra: `[]`

### normalized

Missing: `[]`

Extra: `[]`

## Repair

No repair required.
