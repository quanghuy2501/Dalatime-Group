#!/usr/bin/env node
import { connectDb } from '../src/db/postgres.mjs';
import { runMasterCatalogSync } from '../src/catalog/masterCatalog.mjs';

const db = await connectDb();
try {
  const result = await runMasterCatalogSync({ db });
  console.log(JSON.stringify({ ...result, googleWrites: 0 }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'fail', error: error.message, googleWrites: 0 }, null, 2));
  process.exitCode = 1;
} finally {
  await db.end();
}
