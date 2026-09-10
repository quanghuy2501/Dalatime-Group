import { GoogleApi } from '../src/google/googleApi.mjs';
const id=process.env.MASTER_SPREADSHEET_ID;
const api=await new GoogleApi({minDelayMs:1300,maxRetries:6}).init();
const meta=await api.spreadsheetMeta(id);
console.log(meta.sheets.map(s=>({title:s.properties.title, rows:s.properties.gridProperties?.rowCount, cols:s.properties.gridProperties?.columnCount})).filter(x=>/RAW|NORMAL/i.test(x.title)));
for (const title of ['RAW_DATA','NORMALIZED','RAW_DATA_DB_STAGING','NORMALIZED_DB_STAGING']) {
 const vals=(await api.values(id, `'${title}'!A1:Z5`)).values||[];
 console.log('\n--',title, vals.length); console.log(JSON.stringify(vals,null,2).slice(0,2000));
}
