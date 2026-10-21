import crypto from 'node:crypto';

export const RAW_HEADER = Object.freeze([
  'NGÀY ĐĂNG BÀI','TÊN THƯƠNG HIỆU','TÊN KÊNH','LINK BÀI ĐĂNG','NGƯỜI PHỤ TRÁCH','ĐỘC QUYỀN','VIRAL',
  'VIEW','LIKE','COMMENT','SAVE','SHARE','VIEW_SNAPSHOOT','LIKE_SNAPSHOOT','COMMENT_SNAPSHOOT','SAVE_SNAPSHOOT',
  'SHARE_SNAPSHOOT','% TƯƠNG TÁC','TRẠNG THÁI','THƯỞNG VIRAL','SHOW TÊN KÊNH','SYNC_AT','LINK FILE',
  'LAST_MILESTONE','NOTIFIED_AT','NGÀY XÁC NHẬN VIRAL'
]);
export const NORMALIZED_HEADER = Object.freeze(RAW_HEADER.map((value,index)=>index>=22&&index<=24?'':value));
export const TITLE_ROW = Object.freeze(['BÁO CÁO CÔNG VIỆC HÀNG NGÀY']);
export const GROUP_ROW = Object.freeze(['','','','','','','','REALTIME','','','','','SNAPSHOOT','','','','','','','','','','','','','VIRAL BONUS']);
export const UNTAGGED_BRAND = '(Chưa tag brand)';

const clean=value=>String(value??'').trim();
const number=value=>value===null||value===undefined||value===''?0:Number(value)||0;
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pad=(row,width=26)=>Array.from({length:width},(_,index)=>row?.[index]??'');
const rawValues=row=>Array.isArray(row?.raw_values)?row.raw_values:typeof row?.raw_values==='string'?JSON.parse(row.raw_values):[];

export function googleSerial(value,{withTime=false}={}){
  if(!value)return '';
  const source=/^\d{4}-\d{2}-\d{2}$/.test(String(value))?`${value}T00:00:00.000Z`:value;
  const ms=new Date(source).getTime();
  if(!Number.isFinite(ms))return '';
  const serial=ms/86400000+25569;
  return withTime?serial:Math.floor(serial);
}

export function sourceFileUrl(fileId){
  const id=clean(fileId);
  return id?`https://docs.google.com/spreadsheets/d/${id}/edit`:'';
}

export function canonicalSheetRow(row,{legacyState}={}){
  const source=pad(rawValues(row),22);
  const legacy=legacyState?.get(clean(row.post_url))||{};
  return [
    googleSerial(row.posted_date),clean(row.brand_text_raw),clean(row.channel_name),clean(row.post_url),clean(row.owner_name),
    row.is_exclusive?'Có':clean(source[5]),clean(row.viral_label),number(row.realtime_view),number(row.realtime_like),
    number(row.realtime_comment),number(row.realtime_save),number(row.realtime_share),number(row.snapshot_view),number(row.snapshot_like),
    number(row.snapshot_comment),number(row.snapshot_save),number(row.snapshot_share),number(row.engagement_rate),clean(row.status),
    number(row.bonus_amount),clean(row.show_channel),googleSerial(row.updated_at,{withTime:true}),sourceFileUrl(row.source_file_id),
    legacy.lastMilestone??'',legacy.notifiedAt??'',googleSerial(row.viral_confirm_date)
  ];
}

export function buildFactSheets(posts,{legacyState=new Map()}={}){
  const raw=[]; const normalized=[];
  for(const post of posts){
    const base=canonicalSheetRow(post,{legacyState});
    raw.push(base);
    const brands=Array.isArray(post.brand_names)&&post.brand_names.length?post.brand_names:[UNTAGGED_BRAND];
    for(const brand of brands){const row=[...base];row[1]=brand;normalized.push(row);}
  }
  const rawRows=[TITLE_ROW,[],GROUP_ROW,RAW_HEADER,...raw];
  const normalizedRows=[TITLE_ROW,[],GROUP_ROW,NORMALIZED_HEADER,...normalized];
  return {
    rawRows,normalizedRows,
    rawHash:matrixHash(rawRows),normalizedHash:matrixHash(normalizedRows),
    rawDataRows:raw.length,normalizedDataRows:normalized.length
  };
}

export function matrixHash(rows,width=26){
  return hash((rows||[]).map(row=>pad(row,width).map(value=>value===null||value===undefined?'':value)));
}

const formula=value=>({formula:value});
const invoice=value=>value===true?'Có':value===false?'Không':clean(value);
const existingLink=(links,scope,code)=>clean(links?.get(`${scope}:${code}`));

export function buildCatalogSheets({clients,brands,staff,channels,bonus,links=new Map()}){
  const clientRows=clients.map((row,index)=>{
    const n=index+5,raw=pad(row.raw_row,12);
    return [row.client_code,row.name,row.phone??raw[2],row.tax_id??raw[3],row.address??raw[4],row.email??raw[5],row.status??raw[6],
      formula(`=COUNTIF('4. LIST BRAND'!$D$5:$D;B${n})`),raw[8],existingLink(links,'customer',row.client_code)||row.report_file_id||raw[9],
      row.contact_name??raw[10],invoice(row.invoice_required??raw[11])];
  });
  const brandRows=brands.map(row=>{const raw=pad(row.raw_row,9);return [row.brand_code,row.name,row.group_name??raw[2],row.client_name??raw[3],row.client_code??raw[4],row.start_date??raw[5],row.end_date??raw[6],row.status??raw[7],existingLink(links,'brand',row.brand_code)||raw[8]];});
  const staffRows=staff.map((row,index)=>{const n=index+5,raw=pad(row.raw_row,11);return [row.nv_id,row.name,row.role??raw[2],row.phone??raw[3],row.email??raw[4],formula(`=COUNTIF('3. CHANNEL'!E:E; B${n})`),row.base_salary??raw[6],row.report_file_id??raw[7],formula(`=IF(REGEXMATCH(C${n};\"(?i)fulltime\");\"Fulltime\";IF(REGEXMATCH(C${n};\"(?i)partime\");\"Partime\";\"\"))`),row.status??raw[9],formula(`=IF(J${n}=\"Đang làm\";B${n};\"\")`)];});
  const channelRows=channels.map(row=>[row.channel_code,row.name,row.username??'',row.url??'',row.owner_name??'',number(row.follower)]);
  const bonusRows=bonus.map(row=>[number(row.min_snapshot_view),number(row.amount_fulltime),number(row.amount_parttime)]);
  return {clientRows,brandRows,staffRows,channelRows,bonusRows};
}

export function fingerprintManifest(value){return hash(value);}

