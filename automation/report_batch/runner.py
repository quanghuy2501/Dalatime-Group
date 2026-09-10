"""Fail-closed production orchestration for the read-only-source report pipeline."""
from __future__ import annotations
import json, os, re, shutil, subprocess, time, urllib.request, uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from .config import Settings
from .pipeline import atomic_json, digest, load, reconcile, sync, validate_snapshot

STAGES = ("staging", "validation", "reconciliation", "published")
SECRET_KEY = re.compile(r"(secret|token|password|credential|database_url|notify_url)", re.I)

def _safe(value: Any) -> Any:
    if isinstance(value, dict): return {k: "[REDACTED]" if SECRET_KEY.search(str(k)) else _safe(v) for k,v in value.items()}
    if isinstance(value, list): return [_safe(v) for v in value]
    text = str(value)
    if "postgres" in text or "Bearer " in text or ("@" in text and "://" in text): return "[REDACTED]"
    return value

class JsonlLogger:
    def __init__(self, path: Path, run_id: str): self.path,self.run_id,self.started=path,run_id,time.time(); path.parent.mkdir(parents=True,exist_ok=True)
    def emit(self, event: str, level: str="info", **fields: Any) -> None:
        record={"timestamp":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"run_id":self.run_id,"event":event,"level":level,"duration_ms":round((time.time()-self.started)*1000),**_safe(fields)}
        fd=os.open(self.path,os.O_APPEND|os.O_CREAT|os.O_WRONLY,0o600)
        try: os.write(fd,(json.dumps(record,ensure_ascii=False,sort_keys=True)+"\n").encode()); os.fsync(fd)
        finally: os.close(fd)

@contextmanager
def exclusive_lock(path: Path):
    path.parent.mkdir(parents=True,exist_ok=True)
    try:
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.write(fd,json.dumps({"pid":os.getpid(),"created_at":time.time()}).encode()); os.close(fd)
    except FileExistsError as exc: raise RuntimeError(f"run already active: {path}") from exc
    try: yield
    finally:
        try: path.unlink()
        except FileNotFoundError: pass

def send_alert(url: str|None, payload: dict) -> bool:
    if not url: return False
    request=urllib.request.Request(url,data=json.dumps(_safe(payload),ensure_ascii=False).encode(),headers={"Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(request,timeout=5) as response:
        if response.status >= 300: raise RuntimeError(f"alert hook returned HTTP {response.status}")
    return True

def _stage_manifest(state: Path, run_id: str, stage: str, status: str, **extra: Any) -> dict:
    if stage not in STAGES: raise ValueError(f"unknown stage: {stage}")
    manifest={"schema":"onicorn.production-run.v1","run_id":run_id,"stage":stage,"status":status,"updated_at":time.time(),**extra}
    atomic_json(state/"staging"/"manifest.json",manifest); return manifest

def verify_select(database_url: str, query: str, timeout: int=20) -> dict:
    normalized=re.sub(r"/\*.*?\*/|--[^\n]*","",query,flags=re.S).strip().rstrip(";").strip()
    if not re.fullmatch(r"(?is)select\s+.+",normalized) or ";" in normalized: raise ValueError("DB_VERIFY_SELECT must be exactly one SELECT statement")
    completed=subprocess.run(["psql",database_url,"--no-psqlrc","--set","ON_ERROR_STOP=1","--tuples-only","--command",normalized],capture_output=True,text=True,timeout=timeout,check=False)
    if completed.returncode: raise RuntimeError("database SELECT verification failed")
    return {"ok":True,"row_lines":len([line for line in completed.stdout.splitlines() if line.strip()])}

def go_live_checks(master: Path, state: Path, report: Path, settings: Settings, db_select: str|None=None, db_dir: Path|None=None) -> dict:
    settings.validate(); snapshot=load(master,{})
    snapshot_check=validate_snapshot(snapshot,require_sealed=True)
    if not snapshot_check["valid"]: raise RuntimeError("snapshot gate requires valid, complete, sealed metadata")
    if db_dir is None:
        active=load(state/"published.json",{}).get("active_state_dir")
        db_dir=(state/active/"db") if active else state/"db"
    result=reconcile(master,db_dir,report,state/"reconciliation",require_sealed=True)
    if not result["publish_allowed"]: raise RuntimeError("reconciliation gate blocked publication")
    db_check=verify_select(settings.database_url,db_select) if db_select else {"ok":True,"skipped":True}
    return {"config":{"ok":True},"snapshot":snapshot_check,"reconciliation":result,"database_select":db_check}

def production_run(master: Path, state: Path, report: Path, production: bool=False, settings: Settings|None=None, db_select: str|None=None) -> dict:
    if not production: raise RuntimeError("production run requires explicit --production")
    settings=(settings or Settings.from_env(production=True)).validate(); run_id=str(uuid.uuid4()); logger=JsonlLogger(state/"runs.jsonl",run_id)
    lock_path=Path(settings.lock_file)
    if not lock_path.is_absolute(): lock_path=state/lock_path.name
    with exclusive_lock(lock_path):
        try:
            logger.emit("run_started"); _stage_manifest(state,run_id,"staging","running")
            staged_state=state/"staging"/run_id
            previous=load(state/"published.json",{}).get("active_state_dir")
            if previous:
                previous_state=(state/previous).resolve()
                if state.resolve() not in previous_state.parents: raise RuntimeError("invalid active state path")
                if previous_state.exists(): shutil.copytree(previous_state,staged_state)
            sync_result=sync(master,staged_state,dry_run=False,require_sealed=True)
            if sync_result.get("status") != "ok" or sync_result.get("failed"): raise RuntimeError(f"staging sync blocked: {sync_result.get('reason','file failure')}")
            _stage_manifest(state,run_id,"validation","pass",checkpoint=digest(sync_result))
            checks=go_live_checks(master,state,report,settings,db_select,staged_state/"db"); reconciliation=checks["reconciliation"]
            _stage_manifest(state,run_id,"reconciliation","pass",reconciliation_fingerprint=digest(reconciliation))
            published={"schema":"onicorn.published-manifest.v1","run_id":run_id,"stage":"published","status":"published","published_at":time.time(),"active_state_dir":str(staged_state.relative_to(state)),"snapshot_run_id":reconciliation.get("run_id"),"snapshot_fingerprint":reconciliation.get("fingerprint"),"reconciliation_fingerprint":digest(reconciliation),"counts":reconciliation.get("counts")}
            current=state/"published.json"; lkg=state/"last-known-good.json"
            if current.exists(): shutil.copyfile(current,state/"staging"/"previous-published.json")
            atomic_json(current,published); atomic_json(lkg,published)
            atomic_json(state/"published-snapshot.json",load(master))
            atomic_json(state/"last-known-good-snapshot.json",load(master))
            _stage_manifest(state,run_id,"published","pass",manifest_fingerprint=digest(published)); logger.emit("run_published",counts=published["counts"])
            return {"status":"published","run_id":run_id,"manifest":published}
        except Exception as exc:
            logger.emit("run_blocked",level="error",error_type=type(exc).__name__,error=str(exc))
            try: send_alert(settings.notify_url,{"service":"onicorn-report-worker","run_id":run_id,"status":"blocked","error_type":type(exc).__name__})
            except Exception as alert_exc: logger.emit("alert_failed",level="error",error_type=type(alert_exc).__name__)
            raise

def rollback(state: Path, confirmation: str) -> dict:
    if confirmation != "ROLLBACK": raise RuntimeError("rollback requires --confirm ROLLBACK")
    manifest=load(state/"last-known-good.json"); snapshot=load(state/"last-known-good-snapshot.json")
    if not isinstance(manifest,dict) or manifest.get("status") != "published" or not isinstance(snapshot,dict): raise RuntimeError("no valid last-known-good manifest and snapshot")
    atomic_json(state/"published.json",{**manifest,"rollback":{"confirmed":True,"restored_at":time.time()}})
    atomic_json(state/"published-snapshot.json",snapshot)
    return {"status":"rolled-back","run_id":manifest.get("run_id")}
