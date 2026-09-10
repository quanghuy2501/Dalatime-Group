#!/usr/bin/env python3
"""Offline discrepancy classifier for the Onicorn Master/DB audit.

Reads an evidence JSON containing source/mirror counts and optional artifact metadata.
Never connects to Google or writes to a database; output is evidence only.
"""
from __future__ import annotations
import argparse, json
from pathlib import Path


def classify(e: dict) -> dict:
    counts = e.get('counts', {})
    gaps = {k: int(v.get('master', 0)) - int(v.get('db', 0)) for k, v in counts.items()}
    reasons = []
    if gaps.get('posts'):
        reasons.append('posts are not proven same-snapshot; live audit metadata is 2026-09-08 while mirror counts have no run_id/watermark')
    if gaps.get('post_brands'):
        reasons.append('post_brands is a normalized fan-out relation; compare distinct post keys and brand memberships, not raw row totals')
    if gaps.get('staff'):
        reasons.append('staff count may include inactive/archived Master rows; active-status semantics are not documented in mirror evidence')
    complete = e.get('snapshot', {}).get('complete', False)
    verdict = 'BLOCKED_UNPROVEN' if (not complete or any(gaps.values())) else 'PARITY_PROVEN'
    return {
        'schema': 'onicorn.reconciliation.discrepancy.v1',
        'verdict': verdict,
        'counts': counts,
        'gaps_master_minus_db': gaps,
        'classification': {
            'posts': 'snapshot_or_watermark_mismatch' if gaps.get('posts') else 'no_count_gap',
            'post_brands': 'normalized_fanout_or_duplicate_key_semantics' if gaps.get('post_brands') else 'no_count_gap',
            'staff': 'active_vs_all_staff_semantics' if gaps.get('staff') else 'no_count_gap',
        },
        'evidence_gates': {
            'same_snapshot_run_id': bool(e.get('snapshot', {}).get('run_id')),
            'master_complete': complete,
            'duplicate_key_audit_present': bool(e.get('duplicate_key_audit', False)),
            'source_row_diff_present': bool(e.get('source_row_diff', False)),
        },
        'reasons': reasons,
        'safe_next_action': 'Export one complete locked Master snapshot and a DB read-only snapshot with the same run watermark; compare distinct post_url keys, (post_url, brand) keys, and staff IDs/status before any repair.',
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--evidence', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    a = ap.parse_args()
    result = classify(json.loads(a.evidence.read_text()))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    md = ['# Onicorn reconciliation discrepancy', '', f"- Verdict: **{result['verdict']}**", '']
    md += [f"- {k}: Master {v['master']} vs DB {v['db']} (gap {result['gaps_master_minus_db'][k]})" for k,v in result['counts'].items()]
    md += ['', '## Classification'] + [f"- {k}: {v}" for k,v in result['classification'].items()]
    md += ['', '## Evidence gates'] + [f'- {k}: {v}' for k,v in result['evidence_gates'].items()]
    md += ['', '## Verdict rationale'] + [f'- {x}' for x in result['reasons']]
    md += ['', '## Safe next action', result['safe_next_action'], '']
    a.out.with_suffix('.md').write_text('\n'.join(md))

if __name__ == '__main__':
    main()
