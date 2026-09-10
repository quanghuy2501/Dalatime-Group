import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const reportDir = process.env.PHASE4_REPORT_DIR || path.join(root, 'reports', 'phase4');
fs.mkdirSync(reportDir, { recursive: true });
const output = path.join(reportDir, `master-snapshot-complete-${stamp}.json`);
const env = { ...process.env };
const args = ['scripts/master_snapshot.py', 'snapshot', '--live', '--output', output];
const result = spawnSync('python3', args, { cwd: root, env, encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 2);
const snapshot = JSON.parse(fs.readFileSync(output, 'utf8'));
if (snapshot.status !== 'complete' || snapshot.locked !== true) process.exit(2);
const validation = { status: 'valid', run_id: snapshot.run_id, sha256: snapshot.sha256, checked_at: new Date().toISOString(), read_only: snapshot.read_only === true, sources: snapshot.sources };
fs.writeFileSync(path.join(reportDir, `master-snapshot-validation-${stamp}.json`), JSON.stringify(validation, null, 2) + '\n');
const comparison = process.env.READONLY_COMPARISON_SNAPSHOT;
if (comparison) {
  const json = path.join(reportDir, `discrepancy-audit-${stamp}.json`);
  const md = path.join(reportDir, `discrepancy-audit-${stamp}.md`);
  const audit = spawnSync('python3', ['scripts/master_snapshot.py', 'audit', '--master', output, '--against', comparison, '--json', json, '--md', md], { cwd: root, env, encoding: 'utf8' });
  if (audit.stdout) process.stdout.write(audit.stdout);
  if (audit.stderr) process.stderr.write(audit.stderr);
}
console.log(JSON.stringify({ verdict: 'complete', output, run_id: snapshot.run_id, sha256: snapshot.sha256, duration_ms: snapshot.duration_ms, counts: Object.fromEntries(Object.entries(snapshot.sources).map(([k,v]) => [k,v.row_count])), diagnostics: snapshot.diagnostics }, null, 2));
