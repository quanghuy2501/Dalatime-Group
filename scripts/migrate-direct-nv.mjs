import fs from 'node:fs/promises';
import path from 'node:path';
import { connectDb } from '../src/db/postgres.mjs';

// Apply only the direct-NV schema. The migration is idempotent and runs as one
// transaction; it never contacts Google and never deletes application data.
const file = path.resolve('migrations/007_direct_nv_ingestion.sql');
const db = await connectDb();
try {
  await db.query('begin');
  await db.query("select pg_advisory_xact_lock(hashtext('onicorn:direct-nv-schema'))");
  await db.query(await fs.readFile(file, 'utf8'));
  await db.query('commit');
  console.log(JSON.stringify({ status: 'ok', migration: file }));
} catch (error) {
  await db.query('rollback').catch(() => {});
  console.error(`direct NV migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
