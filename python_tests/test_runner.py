import json, os, sys, unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from automation.report_batch.config import Settings
from automation.report_batch.pipeline import export_snapshot
from automation.report_batch.runner import JsonlLogger, exclusive_lock, production_run, rollback, send_alert, verify_select
from automation.report_batch.runner_cli import dry_run_from_env

def fixture(root):
    raw=root/'raw.json'; master=root/'master.json'; report=root/'report.json'
    raw.write_text(json.dumps({'status':'complete','locked':True,'run_id':'source-1','files':[{'id':'e1','rows':[{'url':'x'}]}]}))
    export_snapshot(raw,master,dry_run=False); report.write_text(json.dumps({'rows':[{'url':'x'}]})); return master,report
def settings(root): return Settings('postgresql://example.invalid/db',str(root),str(root/'run.lock'),None,True)

class RunnerTests(unittest.TestCase):
    def test_worker_default_is_dry_run_and_never_publishes(self):
        with TemporaryDirectory() as d:
            root=Path(d); master,report=fixture(root)
            before=dict(os.environ)
            try:
                os.environ.update({'MASTER_SNAPSHOT_PATH':str(master),'REPORT_SNAPSHOT_PATH':str(report)})
                result=dry_run_from_env()
            finally:
                os.environ.clear(); os.environ.update(before)
            self.assertEqual(result['status'],'dry-run')
            self.assertFalse(result['publish_allowed'])
            self.assertFalse((root/'published.json').exists())

    def test_production_flag_and_lkg_preserved_on_failure(self):
        with TemporaryDirectory() as d:
            root=Path(d); master,report=fixture(root)
            with self.assertRaises(RuntimeError): production_run(master,root,report,False,settings(root))
            result=production_run(master,root,report,True,settings(root)); before=(root/'last-known-good.json').read_bytes(); snapshot_before=(root/'last-known-good-snapshot.json').read_bytes()
            report.write_text(json.dumps({'rows':[]}))
            with self.assertRaises(RuntimeError): production_run(master,root,report,True,settings(root))
            self.assertEqual((root/'last-known-good.json').read_bytes(),before)
            self.assertEqual((root/'last-known-good-snapshot.json').read_bytes(),snapshot_before)
            self.assertEqual(json.loads((root/'published.json').read_text())['run_id'],result['run_id'])
    def test_lock_and_confirmed_rollback(self):
        with TemporaryDirectory() as d:
            root=Path(d); lock=root/'run.lock'
            with exclusive_lock(lock):
                with self.assertRaises(RuntimeError):
                    with exclusive_lock(lock): pass
            (root/'last-known-good.json').write_text(json.dumps({'status':'published','run_id':'good'})); (root/'last-known-good-snapshot.json').write_text('{}')
            with self.assertRaises(RuntimeError): rollback(root,'yes')
            self.assertEqual(rollback(root,'ROLLBACK')['run_id'],'good')
    def test_noop_alert_select_guard_and_redaction(self):
        with TemporaryDirectory() as d:
            root=Path(d); self.assertFalse(send_alert(None,{'token':'secret'}))
            with self.assertRaises(ValueError): verify_select('postgres://secret','DELETE FROM posts')
            JsonlLogger(root/'runs.jsonl','r').emit('failure',database_url='postgres://u:p@h/db')
            self.assertNotIn('u:p',(root/'runs.jsonl').read_text())
if __name__=='__main__': unittest.main()
