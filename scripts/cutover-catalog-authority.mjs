#!/usr/bin/env node
import crypto from 'node:crypto';
import { connectDb } from '../src/db/postgres.mjs';
import { loadLiveMasterCatalogSnapshot, mapBrand, mapChannel, mapStaff } from '../src/importers/liveMaster.mjs';
import { parseNumberVN } from '../src/utils/normalize.mjs';
import { readDatabaseConfig } from '../src/configPush/databaseConfig.mjs';
import { readMasterConfig } from '../src/configPush/configPush.mjs';

const apply=process.argv.includes('--apply');
const clean=value=>String(value??'').trim();
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique=(rows,key,label)=>{
  const seen=new Set();
  for(const row of rows){const value=clean(row[key]);if(!value)continue;if(seen.has(value))throw new Error(`${label} trùng: ${value}`);seen.add(value);}
  return rows;
};
const sourceRow=row=>Number(row.__row)||null;
const staffRow=row=>({
  ...mapStaff(row),phone:clean(row['SỐ ĐIỆN THOẠI'])||null,email:clean(row['EMAIL'])||null,
  base_salary:clean(row['MỨC LƯƠNG'])?parseNumberVN(row['MỨC LƯƠNG']):null,
  employment_type:clean(row['TICK FULLTIME/PARTIME'])||null,status:clean(row['TÌNH TRẠNG']??row['TRẠNG THÁI'])||null,
  config_sort_order:sourceRow(row)
});
const channelRow=row=>({...mapChannel(row),config_sort_order:sourceRow(row)});
const brandRow=row=>({...mapBrand(row),config_sort_order:sourceRow(row)});

function compare(master,database){
  const fold=value=>String(value??'').trim(),key=row=>fold(row[0]);
  return master.sections.map(section=>{
    const other=database.sections.find(item=>item.key===section.key),a=new Map(section.rows.map(row=>[key(row),row])),b=new Map(other.rows.map(row=>[key(row),row]));
    return {section:section.key,masterRows:section.rows.length,databaseRows:other.rows.length,
      missingDatabase:[...a.keys()].filter(item=>!b.has(item)),extraDatabase:[...b.keys()].filter(item=>!a.has(item)),
      changed:[...a.keys()].filter(item=>b.has(item)&&JSON.stringify(a.get(item).map(fold))!==JSON.stringify(b.get(item).map(fold)))};
  });
}

const snapshot=await loadLiveMasterCatalogSnapshot();
const staff=unique(snapshot.staff.filter(row=>clean(row['ID NHÂN VIÊN'])&&clean(row['TÊN NHÂN VIÊN'])).map(staffRow),'nv_id','Mã nhân sự');
const channels=unique(snapshot.channels.filter(row=>clean(row['ID CHANNEL'])||clean(row['TÊN KÊNH'])).map(channelRow),'channel_code','Mã kênh');
const brands=unique(snapshot.brands.filter(row=>clean(row['ID BRAND'])&&clean(row['TÊN THƯƠNG HIỆU'])).map(brandRow),'brand_code','Mã brand');
const db=await connectDb();
try{
  const before=await readDatabaseConfig(db),master=await readMasterConfig(snapshot.api,process.env.MASTER_SPREADSHEET_ID);
  const plan={mode:apply?'apply':'dry-run',counts:{brands:brands.length,staff:staff.length,channels:channels.length},before:compare(master,before),sourceFingerprint:hash({brands:brands.map(x=>x.raw_row),staff:staff.map(x=>x.raw_row),channels:channels.map(x=>x.raw_row)})};
  if(!apply){console.log(JSON.stringify(plan,null,2));process.exit(0);}
  if(process.env.CATALOG_CUTOVER_PRODUCTION!=='1') throw new Error('Apply bị khóa; cần CATALOG_CUTOVER_PRODUCTION=1');
  await db.query('begin');
  await db.query(`select pg_advisory_xact_lock(hashtext('onicorn:catalog-authority-cutover'))`);
  const run=(await db.query(`insert into sync_runs(run_type,status,rows_read,meta) values('catalog_authority_cutover','running',$1,$2) returning id`,[brands.length+staff.length+channels.length,JSON.stringify({sourceFingerprint:plan.sourceFingerprint})])).rows[0];
  await db.query(`update brands set config_visible=false`); await db.query(`update staff set config_visible=false`); await db.query(`update channels set config_visible=false`);
  for(const row of brands) await db.query(`update brands set config_sort_order=$2,config_visible=true where brand_code=$1`,[row.brand_code,row.config_sort_order]);
  for(const row of staff) await db.query(`insert into staff(nv_id,name,role,channels_count,report_file_id,raw_row,active,phone,email,base_salary,employment_type,status,config_sort_order,config_visible)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
    on conflict(nv_id) do update set name=excluded.name,role=excluded.role,channels_count=excluded.channels_count,report_file_id=excluded.report_file_id,
      raw_row=excluded.raw_row,active=excluded.active,phone=excluded.phone,email=excluded.email,base_salary=excluded.base_salary,
      employment_type=excluded.employment_type,status=excluded.status,config_sort_order=excluded.config_sort_order,config_visible=true,updated_at=now()`,
    [row.nv_id,row.name,row.role,row.channels_count,row.report_file_id,JSON.stringify(row.raw_row),row.active,row.phone,row.email,row.base_salary,row.employment_type,row.status,row.config_sort_order]);
  for(const row of channels){
    const owner=(await db.query(`select id,name from staff where lower(trim(name))=lower(trim($1)) order by active desc limit 1`,[row.owner_name])).rows[0];
    if(row.channel_code) await db.query(`insert into channels(channel_code,name,username,url,owner_name,owner_staff_id,follower,raw_row,active,config_sort_order,config_visible)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) on conflict(channel_code) do update set name=excluded.name,username=excluded.username,url=excluded.url,
      owner_name=excluded.owner_name,owner_staff_id=excluded.owner_staff_id,follower=excluded.follower,raw_row=excluded.raw_row,active=excluded.active,config_sort_order=excluded.config_sort_order,config_visible=true,updated_at=now()`,
      [row.channel_code,row.name,row.username,row.url,row.owner_name,owner?.id||null,row.follower,JSON.stringify(row.raw_row),row.active,row.config_sort_order]);
    else {
      const existing=(await db.query(`select id from channels where channel_code is null and lower(trim(name))=lower(trim($1)) limit 1`,[row.name])).rows[0];
      if(existing) await db.query(`update channels set username=$2,url=$3,owner_name=$4,owner_staff_id=$5,follower=$6,raw_row=$7,active=$8,config_sort_order=$9,config_visible=true,updated_at=now() where id=$1`,[existing.id,row.username,row.url,row.owner_name,owner?.id||null,row.follower,JSON.stringify(row.raw_row),row.active,row.config_sort_order]);
      else await db.query(`insert into channels(channel_code,name,username,url,owner_name,owner_staff_id,follower,raw_row,active,config_sort_order,config_visible) values(null,$1,$2,$3,$4,$5,$6,$7,$8,$9,true)`,[row.name,row.username,row.url,row.owner_name,owner?.id||null,row.follower,JSON.stringify(row.raw_row),row.active,row.config_sort_order]);
    }
  }
  const after=await readDatabaseConfig(db),parity=compare(master,after);
  const blockers=parity.filter(item=>item.missingDatabase.length||item.changed.length);
  if(blockers.length) throw new Error(`Parity chưa đạt: ${JSON.stringify(blockers)}`);
  await db.query(`update sync_runs set status='ok',finished_at=now(),rows_written=$2,meta=$3 where id=$1`,[run.id,brands.length+staff.length+channels.length,JSON.stringify({sourceFingerprint:plan.sourceFingerprint,parity})]);
  await db.query('commit');
  console.log(JSON.stringify({...plan,status:'ok',after:parity},null,2));
}catch(error){await db.query('rollback').catch(()=>{});throw error;}finally{await db.end();}
