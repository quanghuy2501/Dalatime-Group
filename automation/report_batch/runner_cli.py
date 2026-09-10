#!/usr/bin/env python3
"""Production CLI. No command writes Google or rotates credentials."""
import argparse, json, os, time, subprocess, tempfile
from pathlib import Path
from .config import Settings
from .runner import go_live_checks, production_run, rollback
from .storage import SupabaseStorage

def env_path(name: str) -> Path:
    value=os.getenv(name,"").strip()
    if not value: raise ValueError(f"{name} is required")
    return Path(value)

def execute_from_env(production: bool) -> dict:
    if not production: return dry_run_from_env()
    state=Path(os.getenv("SNAPSHOT_DIR",".runtime"))
    # Scheduled runs create a fresh read-only Google snapshot in ephemeral storage.
    # An explicit MASTER_SNAPSHOT_PATH remains supported for controlled replays.
    explicit=os.getenv('MASTER_SNAPSHOT_PATH','').strip()
    with tempfile.TemporaryDirectory(prefix='onicorn-cron-') as temp:
        master=Path(explicit) if explicit else Path(temp)/'master-snapshot.json'
        if not explicit:
            exporter=Path(__file__).resolve().parents[2]/'scripts'/'master_snapshot.py'
            credentials=os.getenv('GOOGLE_APPLICATION_CREDENTIALS','').strip()
            if not credentials: raise RuntimeError('GOOGLE_APPLICATION_CREDENTIALS is required for scheduled live snapshot')
            cmd=['python3',str(exporter),'snapshot','--live','--output',str(master)]
            subprocess.run(cmd,check=True,capture_output=True,text=True)
        report_value=os.getenv('REPORT_SNAPSHOT_PATH','').strip()
        if report_value: report=Path(report_value)
        else:
            report=Path(temp)/'report.json'; report.write_text(json.dumps({'rows':[]})+'\n')
        result=production_run(master,state,report,production=True,db_select=os.getenv('DB_VERIFY_SELECT') or None)
        # Upload only after all local validation gates pass. Objects are immutable.
        storage=SupabaseStorage(); run_id=result['run_id']; prefix=f"runs/{run_id}"
        uploaded=storage.upload_file(f'{prefix}/master-snapshot.json',master)
        manifest={**result['manifest'],'storage':uploaded}
        storage.upload_json('published.json',manifest)
        storage.upload_json('last-known-good.json',manifest)
        result['storage']=uploaded
        return result

def dry_run_from_env() -> dict:
    """Validate configured inputs without writing state or publishing."""
    from .pipeline import load, validate_snapshot
    master = env_path("MASTER_SNAPSHOT_PATH")
    report = env_path("REPORT_SNAPSHOT_PATH")
    snapshot = load(master, {})
    check = validate_snapshot(snapshot, require_sealed=True)
    report_ok = isinstance(load(report, None), dict)
    allowed = check["valid"] and report_ok
    return {"status": "dry-run" if allowed else "blocked", "publish_allowed": False,
            "snapshot": check, "report_readable": report_ok}

def main() -> int:
    parser=argparse.ArgumentParser(); sub=parser.add_subparsers(dest="cmd",required=True)
    for name in ("run","check"):
        p=sub.add_parser(name); p.add_argument("--master",type=Path,required=True); p.add_argument("--state-dir",type=Path,required=True); p.add_argument("--report",type=Path,required=True); p.add_argument("--production",action="store_true"); p.add_argument("--db-select")
    p=sub.add_parser("scheduled-run"); p.add_argument("--production",action="store_true")
    p=sub.add_parser("worker"); p.add_argument("--production",action="store_true"); p.add_argument("--interval-seconds",type=int,default=int(os.getenv("WORKER_INTERVAL_SECONDS","3600")))
    p=sub.add_parser("rollback"); p.add_argument("--state-dir",type=Path,required=True); p.add_argument("--confirm",required=True)
    args=parser.parse_args()
    if args.cmd=="run": result=production_run(args.master,args.state_dir,args.report,args.production,db_select=args.db_select)
    elif args.cmd=="check":
        if not args.production: raise RuntimeError("production checks require explicit --production")
        result=go_live_checks(args.master,args.state_dir,args.report,Settings.from_env(True),args.db_select)
    elif args.cmd=="scheduled-run": result=execute_from_env(args.production)
    elif args.cmd=="worker":
        while True:
            try: print(json.dumps(execute_from_env(True) if args.production else dry_run_from_env(),sort_keys=True),flush=True)
            except Exception as exc: print(json.dumps({"status":"blocked","error_type":type(exc).__name__}),flush=True)
            time.sleep(max(60,args.interval_seconds))
    else: result=rollback(args.state_dir,args.confirm)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True)); return 0

if __name__=="__main__": raise SystemExit(main())
