#!/usr/bin/env python3
"""Fail-closed scheduled runner; Google is GET-only and DB access is SELECT-only."""
from __future__ import annotations
import argparse, json, os, subprocess, tempfile, time
from pathlib import Path
from .config import Settings
from .pipeline import atomic_json, export_snapshot, load, validate_snapshot
from .runner import go_live_checks, production_run, rollback
from .storage import SupabaseStorage

class ScheduledRunBlocked(RuntimeError): pass

def env_path(name):
    value=os.getenv(name,'').strip()
    if not value: raise ScheduledRunBlocked(f'{name} is required')
    return Path(value)

def _records(values):
    if not isinstance(values,list) or not all(isinstance(row,list) for row in values):
        raise ScheduledRunBlocked('report snapshot generation unsafe: a Master source is not a row matrix')
    width=max((len(row) for row in values),default=0)
    return [{f'column_{i}':row[i] if i<len(row) else '' for i in range(width)} for row in values]

def _adapt_master(source,destination):
    snapshot=load(source,None)
    if not isinstance(snapshot,dict): raise ScheduledRunBlocked('Master snapshot validation failed: output is not a JSON object')
    if 'metadata' in snapshot and 'files' in snapshot:
        if not validate_snapshot(snapshot,True)['valid']:
            raise ScheduledRunBlocked('Master snapshot validation failed: batch envelope is not complete and sealed')
        return source
    from scripts.master_snapshot import SHEETS, fingerprint
    sources=snapshot.get('sources')
    valid=(snapshot.get('kind')=='onicorn-master-snapshot' and snapshot.get('status')=='complete'
           and snapshot.get('locked') is True and snapshot.get('read_only') is True
           and snapshot.get('source_errors')==[] and isinstance(sources,dict)
           and set(SHEETS).issubset(sources) and snapshot.get('sha256')==fingerprint(sources))
    if not valid:
        raise ScheduledRunBlocked('Master snapshot validation failed: live export is not complete, locked, read-only, and checksum-valid')
    files=[]
    for key in sorted(sources):
        item=sources[key]
        if not isinstance(item,dict) or item.get('row_count')!=len(item.get('values',[])):
            raise ScheduledRunBlocked(f'Master snapshot validation failed: source {key} row count mismatch')
        files.append({'id':key,'rows':_records(item['values'])})
    raw=destination.with_name('master-batch-source.json')
    atomic_json(raw,{'status':'complete','locked':True,'read_only':True,'run_id':snapshot.get('run_id'),'source':'validated-google-master-export','files':files})
    export_snapshot(raw,destination,dry_run=False)
    if not validate_snapshot(load(destination,{}),True)['valid']:
        raise ScheduledRunBlocked('Master snapshot validation failed: adapted batch envelope is invalid')
    return destination

def _scheduled_master(temp):
    explicit=os.getenv('MASTER_SNAPSHOT_PATH','').strip()
    if explicit:
        original=Path(explicit)
        if not original.is_file(): raise ScheduledRunBlocked(f'MASTER_SNAPSHOT_PATH is not a readable file: {original}')
    else:
        credentials=os.getenv('GOOGLE_APPLICATION_CREDENTIALS','').strip()
        spreadsheet_id=os.getenv('MASTER_SPREADSHEET_ID','').strip()
        if not credentials: raise ScheduledRunBlocked('live Master snapshot export unavailable: GOOGLE_APPLICATION_CREDENTIALS is missing')
        if not Path(credentials).is_file(): raise ScheduledRunBlocked('live Master snapshot export unavailable: GOOGLE_APPLICATION_CREDENTIALS does not name a readable file')
        if not spreadsheet_id: raise ScheduledRunBlocked('live Master snapshot export unavailable: MASTER_SPREADSHEET_ID is missing')
        original=temp/'master-snapshot.json'; exporter=Path(__file__).resolve().parents[2]/'scripts'/'master_snapshot.py'
        done=subprocess.run(['python3',str(exporter),'snapshot','--live','--credentials',credentials,'--master-id',spreadsheet_id,'--output',str(original)],capture_output=True,text=True,check=False)
        if done.returncode:
            lines=(done.stderr or done.stdout).strip().splitlines(); detail=f': {lines[-1]}' if lines else ''
            raise ScheduledRunBlocked(f'live Master snapshot export failed with exit {done.returncode}{detail}')
    return _adapt_master(original,temp/'master-batch.json'),original

def _scheduled_report(master,temp):
    explicit=os.getenv('REPORT_SNAPSHOT_PATH','').strip()
    if explicit:
        report=Path(explicit); value=load(report,None)
        if not isinstance(value,dict) or not isinstance(value.get('rows'),list):
            raise ScheduledRunBlocked(f'report snapshot generation unsafe: REPORT_SNAPSHOT_PATH is not a readable rows snapshot: {report}')
        return report
    snapshot=load(master,None); files=snapshot.get('files') if isinstance(snapshot,dict) else None
    if not isinstance(files,list) or not all(isinstance(x,dict) and isinstance(x.get('rows'),list) for x in files):
        raise ScheduledRunBlocked('report snapshot generation unsafe: validated Master has no complete files/rows projection')
    report=temp/'report-snapshot.json'
    atomic_json(report,{'schema':'onicorn.generated-report-snapshot.v1','read_only':True,'source_run_id':snapshot.get('run_id'),'rows':[row for item in files for row in item['rows']]})
    return report

def _storage():
    url=os.getenv('SUPABASE_URL','').strip(); key=os.getenv('SUPABASE_SERVICE_ROLE_KEY','').strip(); bucket=os.getenv('SNAPSHOT_BUCKET','').strip()
    if not url and not key: return None
    missing=[name for name,value in [('SUPABASE_URL',url),('SUPABASE_SERVICE_ROLE_KEY',key),('SNAPSHOT_BUCKET',bucket)] if not value]
    if missing: raise ScheduledRunBlocked(f"Supabase Storage configuration incomplete: missing {', '.join(missing)}")
    return SupabaseStorage(url,key,bucket)

def execute_from_env(production):
    try:
        with tempfile.TemporaryDirectory(prefix='onicorn-cron-',dir='/tmp') as name:
            temp=Path(name); master,original=_scheduled_master(temp); report=_scheduled_report(master,temp)
            check=validate_snapshot(load(master,{}),True)
            if not production:
                return {'status':'dry-run','publish_allowed':False,'snapshot':check,'report_readable':True,'auto_exported':not bool(os.getenv('MASTER_SNAPSHOT_PATH','').strip()),'report_generated':not bool(os.getenv('REPORT_SNAPSHOT_PATH','').strip())}
            storage=_storage(); uploaded=None
            if storage: uploaded=storage.upload_file(f"runs/{load(master,{}).get('run_id')}/master-snapshot.json",original)
            result=production_run(master,Path(os.getenv('SNAPSHOT_DIR','.runtime')),report,True,db_select=os.getenv('DB_VERIFY_SELECT') or None)
            if uploaded: result['storage']=uploaded
            return result
    except ScheduledRunBlocked:
        raise
    except Exception as exc:
        raise ScheduledRunBlocked(f'scheduled run gate failed: {type(exc).__name__}: {exc}') from exc

def dry_run_from_env(): return execute_from_env(False)

def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest='cmd',required=True)
    for name in ('run','check'):
        p=sub.add_parser(name); p.add_argument('--master',type=Path,required=True); p.add_argument('--state-dir',type=Path,required=True); p.add_argument('--report',type=Path,required=True); p.add_argument('--production',action='store_true'); p.add_argument('--db-select')
    p=sub.add_parser('scheduled-run'); p.add_argument('--production',action='store_true')
    p=sub.add_parser('worker'); p.add_argument('--production',action='store_true'); p.add_argument('--interval-seconds',type=int,default=int(os.getenv('WORKER_INTERVAL_SECONDS','3600')))
    p=sub.add_parser('rollback'); p.add_argument('--state-dir',type=Path,required=True); p.add_argument('--confirm',required=True)
    a=ap.parse_args()
    try:
        if a.cmd=='run': result=production_run(a.master,a.state_dir,a.report,a.production,db_select=a.db_select)
        elif a.cmd=='check':
            if not a.production: raise RuntimeError('production checks require explicit --production')
            result=go_live_checks(a.master,a.state_dir,a.report,Settings.from_env(True),a.db_select)
        elif a.cmd=='scheduled-run': result=execute_from_env(a.production)
        elif a.cmd=='worker':
            while True:
                try: print(json.dumps(execute_from_env(a.production),sort_keys=True),flush=True)
                except Exception as exc: print(json.dumps({'status':'blocked','reason':str(exc),'error_type':type(exc).__name__}),flush=True)
                time.sleep(max(60,a.interval_seconds))
        else: result=rollback(a.state_dir,a.confirm)
    except ScheduledRunBlocked as exc:
        print(json.dumps({'status':'blocked','publish_allowed':False,'reason':str(exc)},ensure_ascii=False,sort_keys=True)); return 2
    print(json.dumps(result,ensure_ascii=False,sort_keys=True)); return 0
if __name__=='__main__': raise SystemExit(main())
