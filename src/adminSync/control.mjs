import { spawn } from 'node:child_process';
import { executeConfigPush } from '../configPush/runner.mjs';
import { runDirectNvIngestion } from '../ingestion/directNvRunner.mjs';

export const ACTIONS = Object.freeze(['config_push', 'direct_nv_sync', 'report_refresh_reconcile', 'full_pipeline']);
export const WEBHOOK_STATUS_ACTION = 'status';
export const WEBHOOK_ACTIONS = Object.freeze([...ACTIONS, WEBHOOK_STATUS_ACTION]);
export const isAllowedAction = action => ACTIONS.includes(action);
export const isAllowedWebhookAction = action => WEBHOOK_ACTIONS.includes(action);
const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 2000);

export async function enqueueJob(db, { action, idempotencyKey, requestedBy }) {
  if (!isAllowedAction(action)) { const error = new Error('Action is not allowlisted'); error.statusCode = 400; throw error; }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(idempotencyKey || ''))) { const error = new Error('Idempotency key must be 8-128 safe characters'); error.statusCode = 400; throw error; }
  await db.query('begin');
  try {
    await db.query(`select pg_advisory_xact_lock(hashtext('onicorn:admin-sync-enqueue'))`);
    const prior = await db.query(`select * from admin_sync_jobs where action=$1 and idempotency_key=$2`, [action, idempotencyKey]);
    if (prior.rows[0]) { await db.query('commit'); return { job: prior.rows[0], duplicate: true }; }
    const active = await db.query(`select * from admin_sync_jobs where status in ('queued','running')
      and (action=$1 or action='full_pipeline' or $1='full_pipeline') order by created_at limit 1`, [action]);
    if (active.rows[0]) { await db.query('commit'); return { job: active.rows[0], duplicate: true }; }
    const inserted = await db.query(`insert into admin_sync_jobs(action,status,idempotency_key,requested_by,logs)
      values($1,'queued',$2,$3,'[]'::jsonb) returning *`, [action, idempotencyKey, requestedBy]);
    await db.query('commit'); return { job: inserted.rows[0], duplicate: false };
  } catch (error) { await db.query('rollback').catch(() => {}); throw error; }
}

async function appendLog(db, id, level, message, details = null) {
  const entry = JSON.stringify({ at: new Date().toISOString(), level, message: clean(message), ...(details ? { details } : {}) });
  await db.query(`update admin_sync_jobs set logs=logs || $2::jsonb, updated_at=now() where id=$1`, [id, `[${entry}]`]);
}

export async function reportRefreshReconcile(db) {
  const result = await db.query(`select
    (select count(*)::int from posts_raw_sheet) posts,
    (select count(*)::int from post_brands_sheet) post_brands,
    (select count(*)::int from nv_ingestion_sources where active) active_sources,
    (select count(*)::int from nv_ingestion_checkpoints c join sync_runs r on r.id=c.run_id
      where r.id=(select id from sync_runs where run_type='direct_nv_ingestion' order by started_at desc limit 1) and c.status='fail') failed_sources,
    (select max(finished_at) from sync_runs where run_type='direct_nv_ingestion' and status in ('ok','partial')) last_nv_sync_at`);
  return { refreshed: 'live SQL report views require no materialized refresh', reconciledAt: new Date().toISOString(), ...result.rows[0] };
}

export function runCommand(command, args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const collect = target => chunk => { target.value = (target.value + chunk).slice(-20000); };
    const out = { value: '' }, err = { value: '' }; child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${command} timed out`)); }, timeoutMs); timer.unref?.();
    child.on('error', reject); child.on('close', code => { clearTimeout(timer); stdout=out.value; stderr=err.value; code === 0 ? resolve({ code, stdout:clean(stdout), stderr:clean(stderr) }) : reject(new Error(`${command} exited ${code}: ${clean(stderr || stdout)}`)); });
  });
}

export function createActionRunner({ configPush = options => executeConfigPush(options), directNv = options => runDirectNvIngestion(options) } = {}) {
  return async (action, { db, log }) => {
    const runOne = async name => {
      await log('info', `Starting ${name}`);
      let result;
      if (name === 'config_push') result = await configPush({ production: true });
      else if (name === 'direct_nv_sync') result = await directNv();
      else result = await reportRefreshReconcile(db);
      await log('info', `Completed ${name}`);
      return result;
    };
    if (action === 'full_pipeline') {
      const result = {};
      for (const name of ['config_push', 'direct_nv_sync', 'report_refresh_reconcile']) result[name] = await runOne(name);
      return result;
    }
    return runOne(action);
  };
}

export function createJobWorker({ dbConnector, actionRunner = createActionRunner(), logger = console } = {}) {
  let draining = false;
  const drain = async () => {
    if (draining) return; draining = true;
    const db = await dbConnector(); let locked = false;
    try {
      locked = Boolean((await db.query(`select pg_try_advisory_lock(hashtext('onicorn:admin-sync-worker')) locked`)).rows[0]?.locked);
      if (!locked) return;
      // If this session owns the singleton lock, no previous worker is alive.
      // Reclaim jobs left running by a crashed/restarted process.
      await db.query(`update admin_sync_jobs set status='queued',attempt=attempt+1,started_at=null,updated_at=now(),
        logs=logs || jsonb_build_array(jsonb_build_object('at',now(),'level','warn','message','Worker restarted; job safely re-queued'))
        where status='running'`);
      for (;;) {
        await db.query('begin');
        const claimed = await db.query(`select * from admin_sync_jobs where status='queued' order by created_at for update skip locked limit 1`);
        const job = claimed.rows[0];
        if (!job) { await db.query('commit'); break; }
        await db.query(`update admin_sync_jobs set status='running',started_at=now(),updated_at=now() where id=$1`, [job.id]);
        await db.query('commit');
        const log = (level, message, details) => appendLog(db, job.id, level, message, details);
        try {
          const result = await actionRunner(job.action, { db, log });
          await db.query(`update admin_sync_jobs set status='succeeded',result=$2,finished_at=now(),updated_at=now() where id=$1`, [job.id, JSON.stringify(result ?? {})]);
        } catch (error) {
          await log('error', error.message);
          await db.query(`update admin_sync_jobs set status='failed',error=$2,finished_at=now(),updated_at=now() where id=$1`, [job.id, clean(error.message)]);
        }
      }
    } catch (error) { logger.error?.(`[admin-sync] worker failed: ${clean(error.message)}`); }
    finally { if (locked) await db.query(`select pg_advisory_unlock(hashtext('onicorn:admin-sync-worker'))`).catch(() => {}); await db.end(); draining = false; }
  };
  return { kick() { setImmediate(drain); }, drain, isDraining: () => draining };
}

export async function syncStatus(db, limit = 25) {
  const jobs = (await db.query(`select id,action,status,idempotency_key,requested_by,attempt,logs,result,error,created_at,started_at,finished_at
    from admin_sync_jobs order by created_at desc limit $1`, [limit])).rows;
  const failedSources = (await db.query(`select c.nv_id,c.google_file_id,c.error,c.updated_at from nv_ingestion_checkpoints c
    join sync_runs r on r.id=c.run_id where c.status='fail' and r.id=(select id from sync_runs where run_type='direct_nv_ingestion' order by started_at desc limit 1)
    order by c.updated_at desc`)).rows;
  return { actions: ACTIONS, latest: jobs[0] || null, jobs, failedSources };
}

export async function webhookStatus(db) {
  const result = await db.query(`select
    count(*)::int as total,
    count(*) filter (where status='queued')::int as queued,
    count(*) filter (where status='running')::int as running,
    count(*) filter (where status='succeeded')::int as succeeded,
    count(*) filter (where status='failed')::int as failed,
    max(created_at) as latest_job_at,
    max(finished_at) filter (where status='succeeded') as latest_success_at
    from admin_sync_jobs`);
  const counts = result.rows[0] || {};
  return {
    service: 'ok',
    database: 'ready',
    checkedAt: new Date().toISOString(),
    queue: { queued: Number(counts.queued || 0), running: Number(counts.running || 0) },
    jobs: {
      total: Number(counts.total || 0),
      succeeded: Number(counts.succeeded || 0),
      failed: Number(counts.failed || 0),
      latestJobAt: counts.latest_job_at || null,
      latestSuccessAt: counts.latest_success_at || null
    }
  };
}

export async function retryJob(db, id, requestedBy) {
  const prior = (await db.query(`select action from admin_sync_jobs where id=$1 and status='failed'`, [id])).rows[0];
  if (!prior) { const error = new Error('Only failed jobs can be retried'); error.statusCode = 409; throw error; }
  return enqueueJob(db, { action: prior.action, idempotencyKey: `retry:${id}:${Date.now()}`, requestedBy });
}
