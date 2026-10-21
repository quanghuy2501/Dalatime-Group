import { GoogleApi } from '../google/googleApi.mjs';
import { connectDb } from '../db/postgres.mjs';
import { decryptReportToken,registryKey } from '../report/registry.mjs';
import { ensureSheet,resizeSheet,clearSheet,writeValues } from '../google/sheetsWriter.mjs';
import { buildCatalogSheets,buildFactSheets,fingerprintManifest,matrixHash } from './snapshot.mjs';
import { refreshReportingReadModel } from '../reporting/readModel.mjs';

const OLD_MASTER_ID='1NS7w8J44x09eD1n5WmaCF6UlZDm8sLYThMf_Nhha4p0';
const REQUIRED_TABS=['1. KHACH HANG','4. LIST BRAND','2. NHAN SU','3. CHANNEL','BAO CAO SO LIEU KHACH HANG','BAO CAO NHAN VIEN','RAW_DATA','NORMALIZED','RAW_DATA_DB_STAGING','NORMALIZED_DB_STAGING'];
const STATUS_TAB='DB_MIRROR_STATUS';
const QUALITY_TAB='DB_DATA_QUALITY';
const clean=value=>String(value??'').trim();
const quote=name=>`'${name.replaceAll("'","''")}'`;
const valuesUrl=(id,range,suffix='')=>`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}${suffix}`;
const json=value=>JSON.stringify(value);
const cell=value=>{
  if(value&&typeof value==='object'&&typeof value.formula==='string')return {userEnteredValue:{formulaValue:value.formula}};
  if(typeof value==='number'&&Number.isFinite(value))return {userEnteredValue:{numberValue:value}};
  if(typeof value==='boolean')return {userEnteredValue:{boolValue:value}};
  return {userEnteredValue:{stringValue:String(value??'')}};
};
const rowData=rows=>rows.map(row=>({values:row.map(cell)}));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function sourceSnapshot(db){
  const [posts,clients,brands,staff,channels,bonus,registry,quality]=await Promise.all([
    db.query(`select * from reporting_posts_current order by posted_date nulls last,canonical_key`),
    db.query(`select c.*,coalesce((select count(*) from brands b where b.client_code=c.client_code and b.active),0)::int brand_count from clients c order by c.active desc,c.client_code nulls last,c.name`),
    db.query(`select b.*,coalesce(c.name,b.client_name) client_name from brands b left join clients c on c.client_code=b.client_code order by b.config_sort_order nulls last,b.brand_code`),
    db.query(`select * from staff where config_visible order by config_sort_order nulls last,nv_id`),
    db.query(`select c.*,coalesce(s.name,c.owner_name) owner_name from channels c left join staff s on s.id=c.owner_staff_id where c.config_visible order by c.config_sort_order nulls last,c.channel_code`),
    db.query(`select min_snapshot_view,amount_fulltime,amount_parttime from bonus_rules where active_to is null or active_to>=current_date order by min_snapshot_view`),
    db.query(`select scope,object_code,status,token_ciphertext,token_iv,token_tag from report_link_registry where status='active'`),
    db.query(`select
      (select coalesce(sum(source_row_count-1),0)::int from reporting_posts_canonical) duplicate_source_rows,
      (select count(*)::int from reporting_posts_canonical where posted_date>current_date) future_rows,
      (select count(*)::int from reporting_posts_current where cardinality(brand_names)=0) untagged_posts,
      (select count(distinct case when nullif(trim(post_url),'') is null then row_key else regexp_replace(regexp_replace(lower(trim(post_url)),'\\?.*$',''),'/$','') end)::int from posts_raw_sheet) source_canonical_keys,
      (select count(*)::int from reporting_posts_canonical) canonical_rows,
      (select max(updated_at) from reporting_posts_current) watermark`)
  ]);
  return {posts:posts.rows,clients:clients.rows,brands:brands.rows,staff:staff.rows,channels:channels.rows,bonus:bonus.rows,registry:registry.rows,quality:quality.rows[0]};
}

async function readExistingState(api,id){
  const result=await api.batchValues(id,[`${quote('RAW_DATA')}!D5:D`,`${quote('RAW_DATA')}!X5:Y`,`${quote('1. KHACH HANG')}!A5:J`,`${quote('4. LIST BRAND')}!A5:I`]);
  const [urls,state,clients,brands]=(result.valueRanges||[]).map(item=>item.values||[]);
  const legacyState=new Map();
  urls.forEach((row,index)=>{const url=clean(row?.[0]);if(url)legacyState.set(url,{lastMilestone:state[index]?.[0]??'',notifiedAt:state[index]?.[1]??''});});
  const links=new Map();
  clients.forEach(row=>{if(clean(row?.[0])&&clean(row?.[9]))links.set(`customer:${clean(row[0])}`,row[9]);});
  brands.forEach(row=>{if(clean(row?.[0])&&clean(row?.[8]))links.set(`brand:${clean(row[0])}`,row[8]);});
  return {legacyState,links};
}

function mergeRegistryLinks(existing,rows){
  const links=new Map(existing);const key=registryKey();if(!key)return links;
  for(const row of rows){
    try{const token=decryptReportToken(row,key);if(token)links.set(`${row.scope}:${row.object_code}`,`https://seeding.dalattimegroup.com/report/${token}`);}catch{/* Preserve the current known-good link. */}
  }
  return links;
}

async function verifyTabs(api,id){
  const meta=await api.spreadsheetMeta(id),map=new Map(meta.sheets.map(item=>[item.properties.title,item.properties]));
  const missing=REQUIRED_TABS.filter(name=>!map.has(name));if(missing.length)throw new Error(`target copy is missing required sheets: ${missing.join(', ')}`);
  return {meta,map};
}

async function readPaged(api,id,title,rowCount,{pageRows=2000,width=26}={}){
  const rows=[];
  for(let start=1;start<=rowCount;start+=pageRows){
    const end=Math.min(rowCount,start+pageRows-1);
    const response=await api.values(id,`${quote(title)}!A${start}:Z${end}`);
    const page=response.values||[];
    while(rows.length<start-1)rows.push([]);
    rows.push(...page);
  }
  while(rows.length<rowCount)rows.push([]);
  return rows.slice(0,rowCount).map(row=>Array.from({length:width},(_,index)=>row?.[index]??''));
}

async function stageFacts(api,id,tabMap,facts){
  const specs=[
    {title:'RAW_DATA_DB_STAGING',rows:facts.rawRows,hash:facts.rawHash},
    {title:'NORMALIZED_DB_STAGING',rows:facts.normalizedRows,hash:facts.normalizedHash}
  ];
  for(const spec of specs){
    const properties=tabMap.get(spec.title),buffer=Math.max(20,Math.ceil(spec.rows.length*.05));
    if(properties.gridProperties.rowCount>=spec.rows.length){
      const current=await readPaged(api,id,spec.title,spec.rows.length);
      if(matrixHash(current)===spec.hash)continue;
    }
    await resizeSheet(api,id,properties.sheetId,spec.rows.length+buffer,26);
    await clearSheet(api,id,spec.title);
    await writeValues(api,id,spec.title,spec.rows,{chunkSize:1000});
    const readback=await readPaged(api,id,spec.title,spec.rows.length);
    const actual=matrixHash(readback);
    if(actual!==spec.hash)throw new Error(`${spec.title} staging fingerprint mismatch`);
  }
}

async function publishFacts(api,id,tabMap,facts){
  const specs=[
    {source:'RAW_DATA_DB_STAGING',target:'RAW_DATA',rows:facts.rawRows.length,columns:26},
    {source:'NORMALIZED_DB_STAGING',target:'NORMALIZED',rows:facts.normalizedRows.length,columns:26}
  ];
  for(const spec of specs){
    const target=tabMap.get(spec.target);if(target.gridProperties.rowCount<spec.rows)await resizeSheet(api,id,target.sheetId,spec.rows+Math.max(20,Math.ceil(spec.rows*.05)),target.gridProperties.columnCount);
  }
  const fresh=(await verifyTabs(api,id)).map,requests=[];
  for(const spec of specs){
    const source=fresh.get(spec.source),target=fresh.get(spec.target);
    requests.push({copyPaste:{source:{sheetId:source.sheetId,startRowIndex:0,endRowIndex:spec.rows,startColumnIndex:0,endColumnIndex:spec.columns},destination:{sheetId:target.sheetId,startRowIndex:0,endRowIndex:spec.rows,startColumnIndex:0,endColumnIndex:spec.columns},pasteType:'PASTE_VALUES',pasteOrientation:'NORMAL'}});
    // Removing surplus rows avoids a non-atomic values.clear and preserves every
    // formula/format outside the generated fact sheets. It also keeps the mirror
    // well below the Google Sheets cell ceiling.
    if(spec.rows<target.gridProperties.rowCount)requests.push({deleteDimension:{range:{sheetId:target.sheetId,dimension:'ROWS',startIndex:spec.rows,endIndex:target.gridProperties.rowCount}}});
  }
  await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`,{method:'POST',body:json({requests})});
}

async function publishCatalog(api,id,tabMap,catalog){
  const specs=[
    {title:'1. KHACH HANG',startRow:4,columns:12,rows:catalog.clientRows},
    {title:'4. LIST BRAND',startRow:4,columns:9,rows:catalog.brandRows},
    {title:'2. NHAN SU',startRow:4,columns:11,rows:catalog.staffRows},
    {title:'3. CHANNEL',startRow:4,columns:6,rows:catalog.channelRows},
    {title:'CONFIG',startRow:3,startColumn:5,columns:3,rows:catalog.bonusRows}
  ];
  const requests=[];
  for(const spec of specs){
    const p=tabMap.get(spec.title),startColumn=spec.startColumn||0,endRow=p.gridProperties.rowCount;
    requests.push({updateCells:{range:{sheetId:p.sheetId,startRowIndex:spec.startRow,endRowIndex:Math.max(spec.startRow+spec.rows.length,endRow),startColumnIndex:startColumn,endColumnIndex:startColumn+spec.columns},rows:rowData(spec.rows),fields:'userEnteredValue'}});
  }
  await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`,{method:'POST',body:json({requests})});
}

const formulaValue=value=>value&&typeof value==='object'&&typeof value.formula==='string'?value.formula:value;
async function verifyCatalog(api,id,catalog){
  const specs=[
    {title:'1. KHACH HANG',range:`A5:L${catalog.clientRows.length+4}`,columns:12,rows:catalog.clientRows},
    {title:'4. LIST BRAND',range:`A5:I${catalog.brandRows.length+4}`,columns:9,rows:catalog.brandRows},
    {title:'2. NHAN SU',range:`A5:K${catalog.staffRows.length+4}`,columns:11,rows:catalog.staffRows},
    {title:'3. CHANNEL',range:`A5:F${catalog.channelRows.length+4}`,columns:6,rows:catalog.channelRows},
    {title:'CONFIG',range:`F4:H${catalog.bonusRows.length+3}`,columns:3,rows:catalog.bonusRows}
  ];
  for(const spec of specs){
    const result=await api.fetchJson(valuesUrl(id,`${quote(spec.title)}!${spec.range}`,'?majorDimension=ROWS&valueRenderOption=FORMULA'));
    const actual=(result.values||[]).map(row=>Array.from({length:spec.columns},(_,index)=>row?.[index]??''));
    const expected=spec.rows.map(row=>row.map(formulaValue));
    if(matrixHash(actual,spec.columns)!==matrixHash(expected,spec.columns))throw new Error(`${spec.title} catalog fingerprint mismatch`);
  }
}

async function writeStatus(api,id,statusRows,qualityRows){
  for(const [title,rows] of [[STATUS_TAB,statusRows],[QUALITY_TAB,qualityRows]]){
    const sheetId=await ensureSheet(api,id,title);await resizeSheet(api,id,sheetId,Math.max(30,rows.length+5),8);await clearSheet(api,id,title);await writeValues(api,id,title,rows,{chunkSize:500});
  }
}

async function formulaErrors(api,id){
  const errors=[];
  for(const [title,range] of [['BAO CAO SO LIEU KHACH HANG','A1:AE300'],['BAO CAO NHAN VIEN','A1:AJ300']]){
    const response=await api.fetchJson(valuesUrl(id,`${quote(title)}!${range}`,'?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE'));
    (response.values||[]).forEach((row,ri)=>row.forEach((value,ci)=>{if(typeof value==='string'&&/^#(REF!|ERROR!|VALUE!|NAME\?|DIV\/0!)/.test(value))errors.push({title,row:ri+1,column:ci+1,error:value});}));
  }
  return errors;
}

export async function runMasterMirror({spreadsheetId,apply=false,db,api,log=()=>{}}={}){
  if(!spreadsheetId)throw new Error('MASTER_MIRROR_SPREADSHEET_ID is required');
  if(spreadsheetId===OLD_MASTER_ID||spreadsheetId===process.env.MASTER_SPREADSHEET_ID)throw new Error('refusing to write the legacy production Master');
  if(apply&&process.env.MASTER_MIRROR_PRODUCTION!=='1')throw new Error('apply requires MASTER_MIRROR_PRODUCTION=1');
  const ownDb=!db,ownApi=!api;db||=await connectDb();api||=await new GoogleApi({minDelayMs:1100,maxRetries:6,scopes:[apply?'https://www.googleapis.com/auth/spreadsheets':'https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.metadata.readonly']}).init();
  const started=Date.now();let runId,locked=false;
  try{
    locked=(await db.query(`select pg_try_advisory_lock(hashtext('onicorn:master-report-mirror')) locked`)).rows[0].locked;
    if(!locked)throw new Error('another Master mirror run owns the publication lock');
    const readModelRefresh=await refreshReportingReadModel(db);
    if(!readModelRefresh.refreshed)throw new Error(`reporting read model unavailable: ${readModelRefresh.reason||'refresh failed'}`);
    const {map:tabMap}=await verifyTabs(api,spreadsheetId),existing=await readExistingState(api,spreadsheetId),source=await sourceSnapshot(db);
    if(Number(source.quality.source_canonical_keys)!==Number(source.quality.canonical_rows))throw new Error('reporting read model is stale after refresh');
    const links=mergeRegistryLinks(existing.links,source.registry),facts=buildFactSheets(source.posts,{legacyState:existing.legacyState});
    const catalog=buildCatalogSheets({...source,links});
    const manifest={spreadsheetId,sourceWatermark:source.quality.watermark,readModelRefreshMs:readModelRefresh.durationMs,rawRows:facts.rawDataRows,normalizedRows:facts.normalizedDataRows,rawHash:facts.rawHash,normalizedHash:facts.normalizedHash,catalog:{clients:catalog.clientRows.length,brands:catalog.brandRows.length,staff:catalog.staffRows.length,channels:catalog.channelRows.length,bonus:catalog.bonusRows.length},quality:source.quality};
    manifest.snapshotHash=fingerprintManifest(manifest);
    if(!apply)return {mode:'dry-run',durationMs:Date.now()-started,manifest};
    runId=(await db.query(`insert into master_mirror_runs(spreadsheet_id,status,source_watermark,raw_rows,normalized_rows,snapshot_hash,manifest) values($1,'running',$2,$3,$4,$5,$6) returning id`,[spreadsheetId,manifest.sourceWatermark,manifest.rawRows,manifest.normalizedRows,manifest.snapshotHash,json(manifest)])).rows[0].id;
    log({stage:'staging',runId});await stageFacts(api,spreadsheetId,tabMap,facts);
    log({stage:'publishing',runId});await publishFacts(api,spreadsheetId,tabMap,facts);
    const currentTabs=(await verifyTabs(api,spreadsheetId)).map;await publishCatalog(api,spreadsheetId,currentTabs,catalog);
    await sleep(3000);
    const [rawBack,normBack,errors]=await Promise.all([
      readPaged(api,spreadsheetId,'RAW_DATA',facts.rawRows.length),readPaged(api,spreadsheetId,'NORMALIZED',facts.normalizedRows.length),formulaErrors(api,spreadsheetId)
    ]);
    if(matrixHash(rawBack)!==facts.rawHash)throw new Error('RAW_DATA final fingerprint mismatch');
    if(matrixHash(normBack)!==facts.normalizedHash)throw new Error('NORMALIZED final fingerprint mismatch');
    if(errors.length)throw new Error(`report formula errors: ${json(errors.slice(0,10))}`);
    await verifyCatalog(api,spreadsheetId,catalog);
    const statusRows=[['MASTER REPORTING MIRROR V2'],['STATUS','PUBLISHED'],['RUN_ID',runId],['SOURCE_WATERMARK',String(manifest.sourceWatermark||'')],['PUBLISHED_AT',new Date().toISOString()],['RAW_ROWS',manifest.rawRows],['NORMALIZED_ROWS',manifest.normalizedRows],['SNAPSHOT_HASH',manifest.snapshotHash],['RAW_HASH',manifest.rawHash],['NORMALIZED_HASH',manifest.normalizedHash]];
    const qualityRows=[['DATA QUALITY'],['METRIC','VALUE'],['DUPLICATE SOURCE ROWS',Number(source.quality.duplicate_source_rows||0)],['FUTURE ROWS EXCLUDED',Number(source.quality.future_rows||0)],['UNTAGGED POSTS',Number(source.quality.untagged_posts||0)],['POLICY','Không fuzzy-map; dữ liệu mơ hồ giữ ở quality gate']];
    await writeStatus(api,spreadsheetId,statusRows,qualityRows);
    await db.query(`update master_mirror_runs set status='published',finished_at=now(),duration_ms=$2,manifest=$3 where id=$1`,[runId,Date.now()-started,json({...manifest,formulaErrors:0})]);
    return {mode:'applied',runId,durationMs:Date.now()-started,manifest,formulaErrors:0};
  }catch(error){if(runId)await db.query(`update master_mirror_runs set status='failed',finished_at=now(),duration_ms=$2,error=$3 where id=$1`,[runId,Date.now()-started,String(error.message).slice(0,2000)]).catch(()=>{});throw error;}
  finally{if(locked)await db.query(`select pg_advisory_unlock(hashtext('onicorn:master-report-mirror'))`).catch(()=>{});if(ownDb)await db.end();}
}
