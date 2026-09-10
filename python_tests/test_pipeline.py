import json, sys, unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from automation.report_batch.pipeline import sync, reconcile, export_snapshot, validate_snapshot

class PipelineTests(unittest.TestCase):
    def test_lock_and_idempotency(self):
        with TemporaryDirectory() as d:
            p=Path(d); m=p/'m.json'; m.write_text(json.dumps({'status':'partial','files':[]}))
            self.assertEqual(sync(m,p/'state')['status'],'blocked')
            m.write_text(json.dumps({'status':'complete','files':[{'id':'e1','rows':[{'url':'x'}]}]}))
            self.assertEqual(sync(m,p/'state',False)['changed'],1); self.assertEqual(sync(m,p/'state',False)['changed'],0)
    def test_snapshot_metadata_and_tamper_detection(self):
        with TemporaryDirectory() as d:
            p=Path(d); src=p/'master.json'; out=p/'snapshot.json'; src.write_text(json.dumps({'status':'complete','locked':True,'files':[]}))
            snap=export_snapshot(src,out,dry_run=False); self.assertTrue(out.exists() and validate_snapshot(snap)['valid'])
            snap['files']=[{'id':'tampered','rows':[]}]; self.assertFalse(validate_snapshot(snap)['valid'])
    def test_reconcile_gate(self):
        with TemporaryDirectory() as d:
            p=Path(d); m=p/'m.json'; m.write_text(json.dumps({'status':'complete','files':[{'id':'e1','rows':[{'url':'x'}]}]}))
            state=p/'state'; sync(m,state,False); rep=p/'report.json'; rep.write_text(json.dumps({'rows':[{'url':'x'}]}))
            self.assertTrue(reconcile(m,state/'db',rep,p/'run')['publish_allowed']); rep.write_text(json.dumps({'rows':[]}))
            self.assertFalse(reconcile(m,state/'db',rep,p/'run2')['publish_allowed'])
if __name__=='__main__': unittest.main()
