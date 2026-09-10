"""Minimal liveness/readiness HTTP endpoint; no secrets in responses."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json, os
from .config import ConfigError, Settings

def readiness(state_dir: Path):
    lock=Path(os.getenv('ONICORN_LOCK_FILE',str(state_dir/'run.lock')))
    checks={'state_dir_exists':state_dir.exists(),'writable':os.access(state_dir,os.W_OK) if state_dir.exists() else False}
    try: Settings.from_env(production=os.getenv('ONICORN_ENV')=='production').validate(); checks['config']=True
    except ConfigError: checks['config']=False
    return {'ok': all(checks.values()),'checks':checks,'active_run':lock.exists()}

class Handler(BaseHTTPRequestHandler):
    state_dir=Path(os.getenv('SNAPSHOT_DIR','.runtime'))
    def do_GET(self):
        if self.path not in ('/healthz','/readyz'): self.send_response(404); self.end_headers(); return
        data={'ok':True} if self.path=='/healthz' else readiness(self.state_dir)
        self.send_response(200 if data['ok'] else 503); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps(data).encode())
    def log_message(self,*args): pass

if __name__=='__main__':
    Handler.state_dir.mkdir(parents=True,exist_ok=True)
    HTTPServer((os.getenv('HOST','0.0.0.0'),int(os.getenv('PORT','8080'))),Handler).serve_forever()
