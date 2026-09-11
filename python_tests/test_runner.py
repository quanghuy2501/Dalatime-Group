import json, os, subprocess, sys, unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory
from automation.report_batch.config import Settings
from automation.report_batch.pipeline import export_snapshot
from automation.report_batch.runner import JsonlLogger, exclusive_lock, production_run, rollback, send_alert, verify_select
from automation.report_batch.runner_cli import dry_run_from_env, execute_from_env, main
from scripts.master_snapshot import SHEETS, fingerprint

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

    def test_missing_paths_scheduled_dry_run_auto_exports_without_publish_or_db(self):
        with TemporaryDirectory() as d:
            root=Path(d); credentials=root/'credentials.json'; credentials.write_text('{}')
            sources={key:{'sheet':title,'origin':f'google:test:{title}','row_count':1,'column_count':1,'values':[[key]]} for key,title in SHEETS.items()}
            exported={'schema_version':1,'kind':'onicorn-master-snapshot','run_id':'google-run','status':'complete','locked':True,'read_only':True,'source_errors':[],'sources':sources,'sha256':fingerprint(sources)}
            def fake_export(command,**kwargs):
                self.assertIn('--live',command); self.assertIn('--credentials',command); self.assertNotIn('update',command)
                Path(command[command.index('--output')+1]).write_text(json.dumps(exported))
                return subprocess.CompletedProcess(command,0,'{}','')
            before=dict(os.environ)
            try:
                os.environ.pop('MASTER_SNAPSHOT_PATH',None); os.environ.pop('REPORT_SNAPSHOT_PATH',None)
                os.environ.update({'GOOGLE_APPLICATION_CREDENTIALS':str(credentials),'MASTER_SPREADSHEET_ID':'test'})
                with patch('automation.report_batch.runner_cli.subprocess.run',side_effect=fake_export) as google, \
                     patch('automation.report_batch.runner_cli.production_run') as publish, \
                     patch('automation.report_batch.runner.verify_select') as database:
                    result=execute_from_env(False)
                self.assertTrue(result['auto_exported']); self.assertTrue(result['report_generated'])
                self.assertEqual(result['status'],'dry-run'); google.assert_called_once(); publish.assert_not_called(); database.assert_not_called()
            finally: os.environ.clear(); os.environ.update(before)

    def test_scheduled_blocked_reason_has_exit_two(self):
        before=dict(os.environ); argv=sys.argv
        try:
            for key in ('MASTER_SNAPSHOT_PATH','GOOGLE_APPLICATION_CREDENTIALS'): os.environ.pop(key,None)
            sys.argv=['runner_cli','scheduled-run']
            with patch('builtins.print') as output: code=main()
            self.assertEqual(code,2); self.assertIn('GOOGLE_APPLICATION_CREDENTIALS is missing',output.call_args.args[0])
        finally: sys.argv=argv; os.environ.clear(); os.environ.update(before)
if __name__=='__main__': unittest.main()
