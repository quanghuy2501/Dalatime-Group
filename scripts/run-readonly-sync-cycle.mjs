import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function loadEnv(file = '.env.local') {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
const root = process.cwd();
const phase4 = path.join(root, 'reports/phase4');
const snapshot = process.env.MASTER_SNAPSHOT_FILE || path.join(phase4, 'master-snapshot.json');
const exporter = path.join(root, 'scripts', 'master_snapshot.py');
const env = { ...process.env, READONLY_SYNC: '1', DRY_RUN: '1' };
fs.mkdirSync(phase4, { recursive: true });

function run(name, args, allowed = [0]) {
  console.log(`\n== ${name} ==`);
  const result = spawnSync('python3', [exporter, ...args], { stdio: 'inherit', env, cwd: root });
  if (!allowed.includes(result.status)) throw new Error(`${name} failed (${result.status ?? 'signal'})`);
  return result.status;
}

// Live access is opt-in. The default consumes only checked-in/local CSV fixtures.
const snapshotArgs = process.env.READONLY_LIVE === '1'
  ? ['snapshot', '--live', '--output', snapshot]
  : ['snapshot', '--fixture-dir', process.env.MASTER_FIXTURE_DIR || path.resolve(root, '..'), '--output', snapshot];
run('master:snapshot', snapshotArgs);

const against = process.env.READONLY_COMPARISON_SNAPSHOT;
if (against) {
  run('master:discrepancy', ['audit', '--master', snapshot, '--against', against,
    '--json', path.join(phase4, 'discrepancy.json'), '--md', path.join(phase4, 'discrepancy.md')], [0, 3]);
} else {
  const report = { status: 'not-run', reason: 'Set READONLY_COMPARISON_SNAPSHOT to audit another local snapshot', master_snapshot: snapshot };
  fs.writeFileSync(path.join(phase4, 'discrepancy.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(phase4, 'discrepancy.md'), `# Master Snapshot Discrepancy Audit\n\nStatus: **not-run**\n\n${report.reason}.\n`);
}
console.log(JSON.stringify({ ok: true, readOnly: true, snapshot, finished: new Date().toISOString() }, null, 2));
