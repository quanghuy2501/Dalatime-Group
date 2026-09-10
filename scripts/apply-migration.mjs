import path from 'path';
import { connectDb, runSqlFile } from '../src/db/postgres.mjs';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/apply-migration.mjs migrations/file.sql');
const db = await connectDb();
await runSqlFile(db, path.resolve(file));
await db.end();
console.log('MIGRATION_OK', file);
