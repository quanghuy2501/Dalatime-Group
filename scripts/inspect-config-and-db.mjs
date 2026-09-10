import { GoogleApi } from '../src/google/googleApi.mjs';
import { connectDb } from '../src/db/postgres.mjs';
const api=await new GoogleApi({minDelayMs:1300,maxRetries:6}).init();
const MASTER=process.env.MASTER_SPREADSHEET_ID;
const ranges=["'CONFIG'!A1:H20","'CONFIG'!F1:H20","'CONFIG'!X1:Y20","'CONFIG'!X3:Y11"];
for(const range of ranges){
  try{const r=await api.values(MASTER, range); console.log('\nRANGE',range); console.log(JSON.stringify(r.values,null,2));}
  catch(e){console.log('ERR',range,e.message)}
}
const db=await connectDb();
const q=await db.query(`select table_name from information_schema.tables where table_schema='public' order by table_name`);
console.log('\nTABLES', q.rows.map(r=>r.table_name));
await db.end();
