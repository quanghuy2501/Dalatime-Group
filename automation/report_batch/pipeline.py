#!/usr/bin/env python3
"""Safe, offline-first Master -> DB mirror -> customer report pipeline.

Inputs are JSON snapshots. No Google API/write is performed unless a caller supplies
snapshots explicitly; this module is deliberately read-only at the source boundary.
"""
from __future__ import annotations
import argparse, hashlib, json, os, tempfile, time, uuid
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 'onicorn.master.snapshot.v1'


def snapshot_metadata(master: dict) -> dict:
    """Return immutable provenance for a Master export (never sends data anywhere)."""
    payload = {'files': master.get('files', []), 'status': master.get('status', 'unknown')}
    return {
        'schema': SCHEMA_VERSION,
        'run_id': str(master.get('run_id') or uuid.uuid4()),
        'status': master.get('status', 'unknown'),
        'locked': bool(master.get('locked', False)),
        'fingerprint': digest(payload),
        'source': master.get('source', 'google-master-export'),
    }


def export_snapshot(source: Path, destination: Path | None = None, dry_run: bool = True) -> dict:
    """Normalize a legacy/current Master JSON export into a verifiable envelope."""
    master = load(source)
    if not isinstance(master, dict):
        raise ValueError('master snapshot must be an object')
    result = dict(master)
    result['metadata'] = snapshot_metadata(master)
    result['run_id'] = result['metadata']['run_id']
    result['fingerprint'] = result['metadata']['fingerprint']
    if destination is not None and not dry_run:
        atomic_json(destination, result)
    return result


def validate_snapshot(snapshot: dict, require_sealed: bool = False) -> dict:
    metadata = snapshot.get('metadata', {})
    required = ('run_id', 'status', 'locked', 'fingerprint')
    missing = [key for key in required if key not in metadata]
    expected = snapshot_metadata(snapshot)['fingerprint']
    complete = metadata.get('status') == 'complete' and snapshot.get('status') == 'complete'
    sealed = metadata.get('locked') is True and snapshot.get('locked') is True
    valid = not missing and metadata.get('fingerprint') == expected and complete
    if require_sealed:
        valid = valid and sealed
    return {'valid': valid, 'missing': missing,
            'fingerprint_match': metadata.get('fingerprint') == expected,
            'complete': complete, 'sealed': sealed}

RETRIES = 3

def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    with os.fdopen(fd, 'w', encoding='utf-8') as f: json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def load(path: Path, default=None):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def _norm_key(value: Any) -> str:
    return ' '.join(str(value or '').strip().lower().replace('\\n', ' ').split())


def normalize_rows(rows: list[dict]) -> tuple[list[dict], dict]:
    """Remove sheet scaffolding while preserving real rows and stable ordering.

    Header/instruction/blank rows are presentation artifacts, not records. Duplicate
    records are collapsed by the strongest available semantic key; rows without a
    key are retained (they cannot safely be identified as duplicates).
    """
    kept, seen, dropped = [], set(), {'empty': 0, 'header_or_instruction': 0, 'duplicate': 0}
    for row in rows or []:
        if not isinstance(row, dict):
            dropped['empty'] += 1; continue
        values = {_norm_key(v) for v in row.values() if str(v or '').strip()}
        if not values:
            dropped['empty'] += 1; continue
        joined = ' '.join(sorted(values))
        if ('instruction' in joined or 'do not edit' in joined or
            ('post_url' in values and ('brand' in values or 'status' in values))):
            dropped['header_or_instruction'] += 1; continue
        url = next((row[k] for k in row if _norm_key(k) in ('post_url','url','link')), '')
        brand = next((row[k] for k in row if _norm_key(k) in ('brand','post_brand')), '')
        staff = next((row[k] for k in row if _norm_key(k) in ('staff_id','employee_id','email')), '')
        key = ('post_brand', _norm_key(url), _norm_key(brand)) if url and brand else ('staff', _norm_key(staff)) if staff else None
        if key and key in seen:
            dropped['duplicate'] += 1; continue
        if key: seen.add(key)
        kept.append(row)
    return kept, dropped

def sync(source: Path, state_dir: Path, dry_run=True, retries=RETRIES,
         require_sealed=False) -> dict:
    """Mirror each employee file into a local DB snapshot, idempotently."""
    master = load(source)
    if not isinstance(master, dict): raise ValueError('master snapshot must be an object')
    snapshot_check = validate_snapshot(master, require_sealed=require_sealed) if 'metadata' in master else None
    if master.get('status') != 'complete':
        return {'status':'blocked','reason':'master_not_complete','files':[]}
    if require_sealed and (not snapshot_check or not snapshot_check['valid']):
        return {'status':'blocked','reason':'master_not_valid_complete_and_sealed','files':[],
                'snapshot_check': snapshot_check}
    files = master.get('files', [])
    state = load(state_dir/'checkpoint.json', {'files':{}})
    result = {'status':'dry-run' if dry_run else 'ok', 'files':[], 'changed':0, 'failed':0}
    for item in files:
        file_id = str(item.get('id') or item.get('file_id') or '')
        if not file_id: result['failed'] += 1; continue
        rows, dropped = normalize_rows(item.get('rows', []))
        fp = digest(rows)
        previous = state['files'].get(file_id, {})
        entry = {'id':file_id,'fingerprint':fp,'rows':len(rows),'dropped':dropped,'status':'unchanged' if previous.get('fingerprint') == fp else 'changed'}
        if entry['status'] == 'changed': result['changed'] += 1
        if not dry_run:
            # Per-file commit: checkpoint only after successful atomic write.
            target = state_dir/'db'/f'{file_id}.json'
            for attempt in range(retries):
                try:
                    atomic_json(target, {'file_id':file_id,'fingerprint':fp,'rows':rows})
                    state['files'][file_id] = entry; break
                except OSError:
                    if attempt == retries-1: entry['status']='failed'; result['failed'] += 1
                    else: time.sleep(0.05 * (2**attempt))
        result['files'].append(entry)
    if not dry_run: atomic_json(state_dir/'checkpoint.json', state)
    return result

def reconcile(master_path: Path, db_dir: Path, report_path: Path, out: Path,
              require_sealed: bool = False) -> dict:
    master = load(master_path, {}); expected = master.get('files', [])
    snapshot_check = validate_snapshot(master, require_sealed=require_sealed) if 'metadata' in master else {'valid': not require_sealed, 'legacy': True}
    master_rows = [r for f in expected for r in f.get('rows', [])]
    db_rows = []
    for p in sorted(db_dir.glob('*.json')):
        d = load(p, {}); db_rows.extend(d.get('rows', []))
    report = load(report_path, {})
    checks = {'master_db': digest(master_rows) == digest(db_rows),
              'db_report': digest(db_rows) == digest(report.get('rows', [])),
              'master_complete': master.get('status') == 'complete'}
    checks['snapshot_metadata'] = snapshot_check['valid']
    result = {'status':'pass' if all(checks.values()) else 'blocked','publish_allowed':all(checks.values()),'checks':checks,
              'run_id': master.get('run_id') or snapshot_check.get('run_id'),
              'fingerprint': (master.get('metadata') or {}).get('fingerprint'),
              'counts':{'master':len(master_rows),'db':len(db_rows),'report':len(report.get('rows',[]))}}
    atomic_json(out.with_suffix('.json'), result)
    out.with_suffix('.md').write_text('# Reconciliation\n\n- Status: **%s**\n- Publish allowed: **%s**\n\n%s\n' % (result['status'], result['publish_allowed'], '\n'.join(f'- {k}: {v}' for k,v in checks.items())), encoding='utf-8')
    return result

def main():
    ap=argparse.ArgumentParser(description='Onicorn Report OS safe orchestrator (dry-run default)')
    sub=ap.add_subparsers(dest='cmd',required=True)
    s=sub.add_parser('sync'); s.add_argument('--master',type=Path,required=True); s.add_argument('--state-dir',type=Path,required=True); s.add_argument('--commit',action='store_true',help='write local mirror; never writes Google')
    r=sub.add_parser('reconcile'); r.add_argument('--master',type=Path,required=True); r.add_argument('--db-dir',type=Path,required=True); r.add_argument('--report',type=Path,required=True); r.add_argument('--out',type=Path,required=True)
    x=sub.add_parser('snapshot', help='validate/export a local Google Master JSON export (read-only)'); x.add_argument('--master',type=Path,required=True); x.add_argument('--out',type=Path); x.add_argument('--commit',action='store_true',help='write local snapshot only; never writes Google')
    a=ap.parse_args()
    if a.cmd=='sync': result=sync(a.master,a.state_dir,not a.commit)
    elif a.cmd=='reconcile': result=reconcile(a.master,a.db_dir,a.report,a.out)
    else:
        result=export_snapshot(a.master,a.out,not a.commit)
        result={'status':'exported' if a.commit else 'dry-run','run_id':result['run_id'],'fingerprint':result['fingerprint'],'metadata':result['metadata'],'output':str(a.out) if a.commit and a.out else None}
    print(json.dumps(result,ensure_ascii=False,indent=2)); raise SystemExit(0 if result.get('status') not in ('blocked',) else 2)
if __name__=='__main__': main()
