import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectDb } from '../src/db/postgres.mjs';
import { canonicalMaster, compareKeySets, loadCanonicalDatabase } from '../src/reconciliation/currentWatermarkParity.mjs';

const started = Date.now();
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const snapshotFile = arg('--snapshot');
if (!snapshotFile) throw new Error('usage: node scripts/current-watermark-parity.mjs --snapshot <locked-snapshot.json> [--stamp <UTC stamp>]');
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
const stamp = arg('--stamp') || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const reportDir = path.join(process.cwd(), 'reports', 'phase4');
const base = path.join(reportDir, `current-watermark-parity-${stamp}`);
const runId = randomUUID();
let db;
try {
  const masterStarted = Date.now();
  const master = canonicalMaster(snapshot);
  const masterLatency = Date.now() - masterStarted;
  const dbStarted = Date.now();
  db = await connectDb();
  await db.query('begin read only');
  const database = await loadCanonicalDatabase(db);
  await db.query('commit');
  const dbLatency = Date.now() - dbStarted;
  const checks = compareKeySets(master, database);
  const mismatchCount = Object.values(checks).reduce((n, check) => n + check.missing_count + check.extra_count, 0);
  const report = {
    schema_version: 1, kind: 'current-watermark-parity', run_id: runId,
    generated_at: new Date().toISOString(), read_only: true, google_writes: false, database_writes: false,
    watermark: snapshot.watermark, master_snapshot: { file: snapshotFile, run_id: snapshot.run_id, sha256: snapshot.sha256 },
    verdict: mismatchCount ? 'blocked' : 'pass', publish_allowed: mismatchCount === 0,
    counts: Object.fromEntries(Object.entries(checks).map(([name, c]) => [name, { master: c.master_count, database: c.database_count, missing: c.missing_count, extra: c.extra_count }])),
    latency_ms: { master_normalization: masterLatency, database_select: dbLatency, total: Date.now() - started }, checks,
    repair: { performed: false, reason: mismatchCount ? 'Mismatch requires review; staleness is not proven by parity alone.' : 'No repair required.' }
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const lines = ['# Current-watermark parity', '', `- Verdict: **${report.verdict}**`, `- Run ID: \`${runId}\``, `- Watermark: \`${JSON.stringify(report.watermark)}\``, `- Read-only: **true** (no Google or DB writes)`, `- Latency: master ${masterLatency} ms; DB SELECT ${dbLatency} ms; total ${report.latency_ms.total} ms`, '', '## Counts', '', '| Dataset | Master | DB | Missing | Extra |', '|---|---:|---:|---:|---:|', ...Object.entries(report.counts).map(([name,c]) => `| ${name} | ${c.master} | ${c.database} | ${c.missing} | ${c.extra} |`), '', '## Exact differences', ''];
  for (const [name, check] of Object.entries(checks)) lines.push(`### ${name}`, '', `Missing: \`${JSON.stringify(check.missing)}\``, '', `Extra: \`${JSON.stringify(check.extra)}\``, '');
  lines.push('## Repair', '', report.repair.reason, '');
  fs.writeFileSync(`${base}.md`, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ verdict: report.verdict, run_id: runId, files: [`${base}.json`, `${base}.md`], counts: report.counts, latency_ms: report.latency_ms }, null, 2));
  process.exitCode = mismatchCount ? 3 : 0;
} catch (error) {
  const latency = Date.now() - started;
  const report = {
    schema_version: 1, kind: 'current-watermark-parity', run_id: runId,
    generated_at: new Date().toISOString(), read_only: true, google_writes: false, database_writes: false,
    watermark: snapshot?.watermark ?? null,
    master_snapshot: { file: snapshotFile, run_id: snapshot?.run_id ?? null, sha256: snapshot?.sha256 ?? null },
    verdict: 'blocked', publish_allowed: false, counts: null,
    latency_ms: { total: latency },
    checks: null,
    missing: null, extra: null,
    blocker: { name: error.name, code: error.code ?? error.cause?.code ?? null, message: error.message },
    repair: { performed: false, reason: 'Parity could not be proven; fail closed and do not mutate either system.' }
  };
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, `# Current-watermark parity\n\n- Verdict: **blocked**\n- Run ID: \`${runId}\`\n- Watermark: \`${JSON.stringify(report.watermark)}\`\n- Read-only: **true** (no Google or DB writes)\n- Total latency: **${latency} ms**\n\n## Blocker\n\n\`${error.code ?? error.cause?.code ?? error.name}: ${error.message}\`\n\nCounts and exact missing/extra lists are **unavailable**, because the DB SELECT snapshot did not complete. The gate failed closed.\n\n## Repair\n\nNo repair was attempted because current-watermark parity and safe DB staleness were not proven.\n`);
  console.error(JSON.stringify({ verdict: 'blocked', run_id: runId, files: [`${base}.json`, `${base}.md`], blocker: report.blocker, latency_ms: report.latency_ms }, null, 2));
  process.exitCode = 2;
} finally {
  if (db) await db.end();
}
