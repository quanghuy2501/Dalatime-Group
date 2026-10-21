import { encryptReportToken, newRegistryToken, registryKey, upsertRegistryToken } from '../report/registry.mjs';

const clean = value => String(value ?? '').trim();
const asNullable = value => clean(value) || null;
const asBool = value => value === true || value === 'true' || value === 1 || value === '1';
const badRequest = message => { const error = new Error(message); error.statusCode = 400; return error; };
const conflict = message => { const error = new Error(message); error.statusCode = 409; return error; };
const notFound = message => { const error = new Error(message); error.statusCode = 404; return error; };
const FIELD_LIMIT = 500;

const definitions = Object.freeze({
  clients: Object.freeze({
    table: 'clients', code: 'client_code', prefix: 'KH', minDigits: 5,
    fields: Object.freeze(['name','phone','tax_id','address','email','status','contact_name','invoice_required','active']),
    required: Object.freeze(['name']),
    select: `select c.id,c.client_code code,c.name,
      coalesce(c.phone,c.raw_row->>2) phone,coalesce(c.tax_id,c.raw_row->>3) tax_id,
      coalesce(c.address,c.raw_row->>4) address,coalesce(c.email,c.raw_row->>5) email,
      coalesce(c.status,c.raw_row->>6) status,coalesce(c.contact_name,c.raw_row->>10) contact_name,
      coalesce(c.invoice_required,case lower(trim(coalesce(c.raw_row->>11,''))) when 'có' then true when 'co' then true when 'yes' then true when 'true' then true else false end) invoice_required,
      c.active,c.change_version,c.created_at,c.updated_at,
      (select count(*)::int from brands b where b.client_code=c.client_code and b.active) related_count
      from clients c`
  }),
  brands: Object.freeze({
    table: 'brands', code: 'brand_code', prefix: 'CH', minDigits: 3,
    fields: Object.freeze(['name','group_name','client_code','start_date','end_date','status','active']),
    required: Object.freeze(['name','client_code']), reportScope: 'brand',
    select: `select b.id,b.brand_code code,b.name,coalesce(b.group_name,b.raw_row->>2) group_name,
      b.client_code,coalesce(b.client_name,c.name,b.raw_row->>3) client_name,
      coalesce(b.start_date::text,nullif(b.raw_row->>5,'')) start_date,
      coalesce(b.end_date::text,nullif(b.raw_row->>6,'')) end_date,
      coalesce(b.status,b.raw_row->>7) status,b.active,b.change_version,b.created_at,b.updated_at,
      coalesce(pc.related_count,0) related_count
      from brands b left join lateral (
        select name from clients where client_code=b.client_code order by active desc,updated_at desc,id limit 1
      ) c on true left join (
        select lower(trim(brand_name)) brand_key,count(*)::int related_count
        from reporting_posts_current p cross join lateral unnest(p.brand_names) brand_name
        group by lower(trim(brand_name))
      ) pc on pc.brand_key=lower(trim(b.name))`
  }),
  staff: Object.freeze({
    table: 'staff', code: 'nv_id', prefix: 'NV', minDigits: 2,
    fields: Object.freeze(['name','role','phone','email','base_salary','employment_type','status','report_file_id','active']),
    required: Object.freeze(['name']),
    select: `select s.id,s.nv_id code,s.name,coalesce(s.role,s.raw_row->>2) role,
      coalesce(s.phone,s.raw_row->>3) phone,coalesce(s.email,s.raw_row->>4) email,
      coalesce(s.base_salary::text,nullif(s.raw_row->>6,'')) base_salary,
      coalesce(s.employment_type,s.raw_row->>8) employment_type,
      coalesce(s.status,s.raw_row->>9) status,coalesce(s.report_file_id,s.raw_row->>7) report_file_id,
      s.active,s.change_version,s.created_at,s.updated_at,
      (select count(*)::int from channels c where c.active and (c.owner_staff_id=s.id or lower(trim(c.owner_name))=lower(trim(s.name)))) related_count,
      ns.google_file_id employee_sheet_id,ns.status source_status,ns.active source_active
      from staff s left join nv_ingestion_sources ns on ns.nv_id=s.nv_id`
  }),
  channels: Object.freeze({
    table: 'channels', code: 'channel_code', prefix: 'CH', minDigits: 3,
    fields: Object.freeze(['name','username','url','owner_staff_id','follower','active']),
    required: Object.freeze(['name']),
    select: `select c.id,c.channel_code code,c.name,c.username,c.url,c.owner_staff_id,
      coalesce(s.name,c.owner_name) owner_name,c.follower,c.active,c.change_version,c.created_at,c.updated_at,
      coalesce(pc.related_count,0) related_count
      from channels c left join staff s on s.id=c.owner_staff_id left join (
        select lower(trim(channel_name)) channel_key,count(*)::int related_count
        from reporting_posts_current group by lower(trim(channel_name))
      ) pc on pc.channel_key=lower(trim(c.name))`
  })
});

export const catalogEntities = Object.freeze(Object.keys(definitions));
export function catalogDefinition(entity) {
  const definition = definitions[entity];
  if (!definition) throw badRequest('Danh mục không hợp lệ');
  return definition;
}

const scalar = (field, value) => {
  if (field === 'active' || field === 'invoice_required') return asBool(value);
  if (field === 'follower') {
    const parsed = Number(value || 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw badRequest('Follower phải là số nguyên không âm');
    return parsed;
  }
  if (field === 'base_salary') {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(String(value).replace(/[.,\s]/g, ''));
    if (!Number.isFinite(parsed) || parsed < 0) throw badRequest('Mức lương không hợp lệ');
    return parsed;
  }
  if (field === 'start_date' || field === 'end_date') {
    if (!clean(value)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(value))) throw badRequest('Ngày phải có định dạng YYYY-MM-DD');
    return clean(value);
  }
  const result = asNullable(value);
  if (result && result.length > FIELD_LIMIT) throw badRequest(`${field} vượt quá ${FIELD_LIMIT} ký tự`);
  if (field === 'email' && result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw badRequest('Email không hợp lệ');
  if (field === 'url' && result && !/^https?:\/\//i.test(result)) throw badRequest('Link kênh phải bắt đầu bằng http:// hoặc https://');
  return result;
};

export function validateCatalogPayload(entity, input, { partial = false } = {}) {
  const definition = catalogDefinition(entity);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Dữ liệu không hợp lệ');
  const unknown = Object.keys(input).filter(key => !definition.fields.includes(key) && !['code','expectedVersion'].includes(key));
  if (unknown.length) throw badRequest(`Trường không được phép: ${unknown.join(', ')}`);
  const payload = {};
  for (const field of definition.fields) if (Object.hasOwn(input, field)) payload[field] = scalar(field, input[field]);
  if (!partial) for (const field of definition.required) if (!clean(payload[field])) throw badRequest(`Thiếu trường bắt buộc: ${field}`);
  if (payload.start_date && payload.end_date && payload.start_date > payload.end_date) throw badRequest('Ngày kết thúc phải sau ngày bắt đầu');
  return payload;
}

function rowView(definition, row) {
  const view = {};
  for (const field of definition.fields) view[field] = row[field] ?? null;
  view.id = row.id; view.code = row.code; view.change_version = row.change_version;
  return view;
}

async function assertRelations(db, entity, payload, existing = {}) {
  if (entity === 'brands' && Object.hasOwn(payload, 'client_code')) {
    const client = (await db.query(`select name,active from clients where client_code=$1 order by active desc limit 1`, [payload.client_code])).rows[0];
    if (!client || !client.active) throw badRequest('Khách hàng không tồn tại hoặc đã ngưng hoạt động');
    payload.client_name = client.name;
  }
  if (entity === 'channels' && Object.hasOwn(payload, 'owner_staff_id')) {
    if (!payload.owner_staff_id) { payload.owner_staff_id = null; payload.owner_name = null; }
    else {
      const staff = (await db.query(`select id,name,active from staff where id=$1`, [payload.owner_staff_id])).rows[0];
      if (!staff || !staff.active) throw badRequest('Nhân sự phụ trách không tồn tại hoặc đã nghỉ');
      payload.owner_name = staff.name;
    }
  }
  if (payload.active === false) {
    if (entity === 'clients') {
      const linked = Number((await db.query(`select count(*)::int n from brands where active and client_code=$1`, [existing.code])).rows[0]?.n || 0);
      if (linked) throw conflict(`Không thể ngưng khách hàng đang có ${linked} brand hoạt động`);
    }
    if (entity === 'staff') {
      const linked = Number((await db.query(`select count(*)::int n from channels where active and (owner_staff_id=$1 or lower(trim(owner_name))=lower(trim($2)))`, [existing.id, existing.name])).rows[0]?.n || 0);
      if (linked) throw conflict(`Không thể ngưng nhân sự đang phụ trách ${linked} kênh`);
    }
  }
}

async function nextCode(db, definition) {
  await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [`onicorn:catalog-code:${definition.table}`]);
  const result = await db.query(`select ${definition.code} code from ${definition.table} where ${definition.code} ~ $1`, [`^${definition.prefix}[0-9]+$`]);
  let max = 0, width = definition.minDigits;
  for (const row of result.rows) {
    const digits = clean(row.code).slice(definition.prefix.length);
    max = Math.max(max, Number(digits) || 0); width = Math.max(width, digits.length);
  }
  return `${definition.prefix}${String(max + 1).padStart(width, '0')}`;
}

async function audit(db, { entity, id, code, action, actor, before, after, changedFields }) {
  await db.query(`insert into admin_catalog_audit(entity_type,entity_id,entity_code,action,actor,before_data,after_data,changed_fields)
    values($1,$2,$3,$4,$5,$6,$7,$8)`, [entity,id,code,action,actor,JSON.stringify(before),JSON.stringify(after),changedFields]);
}

async function syncReportAccess(db, entity, row) {
  const scope = entity === 'clients' ? 'customer' : entity === 'brands' ? 'brand' : null;
  if (!scope) return { state: 'not-applicable' };
  if (!row.active) {
    await db.query(`update report_link_registry set status='revoked',revoked_at=now() where scope=$1 and object_code=$2 and status='active'`, [scope,row.code]);
    return { state: 'revoked' };
  }
  const existing = (await db.query(`select status from report_link_registry where scope=$1 and object_code=$2`, [scope,row.code])).rows[0];
  if (existing?.status === 'active') return { state: 'active' };
  const key = registryKey();
  if (!key) throw conflict('Thiếu khóa mã hóa report, chưa thể tạo link an toàn');
  const { token, tokenHash } = newRegistryToken();
  await upsertRegistryToken(db, { scope, code: row.code, tokenHash, encrypted: encryptReportToken(token, key) });
  return { state: 'created', reportPath: `/report/${token}` };
}

async function refreshStaffChannelCounts(db,ids=[]){
  for(const id of [...new Set(ids.filter(Boolean))]) await db.query(`update staff s set channels_count=(select count(*)::int from channels c where c.active and c.owner_staff_id=s.id),updated_at=now() where s.id=$1`,[id]);
}

export async function listCatalog(db, entity, { q = '', active = '', limit = 500, offset = 0 } = {}) {
  const definition = catalogDefinition(entity);
  const where = [], values = [];
  if (clean(q)) { values.push(`%${clean(q)}%`); where.push(`(x.code ilike $${values.length} or x.name ilike $${values.length})`); }
  if (active === 'true' || active === 'false') { values.push(active === 'true'); where.push(`x.active=$${values.length}`); }
  const safeLimit = Math.min(Math.max(Number(limit) || 100,1),1000), safeOffset = Math.max(Number(offset) || 0,0);
  values.push(safeLimit); const lp = `$${values.length}`; values.push(safeOffset); const op = `$${values.length}`;
  const base = `(${definition.select}) x`;
  const countBase = `(select ${definition.code} code,name,active from ${definition.table}) x`;
  const filter = where.length ? `where ${where.join(' and ')}` : '';
  const [rows,count] = await Promise.all([
    db.query(`select * from ${base} ${filter} order by active desc,name,code limit ${lp} offset ${op}`, values),
    db.query(`select count(*)::int total from ${countBase} ${filter}`, values.slice(0,-2))
  ]);
  return { entity, rows: rows.rows, total: count.rows[0].total, limit:safeLimit, offset:safeOffset };
}

export async function catalogSummary(db) {
  const result = {};
  for (const entity of catalogEntities) {
    const definition = definitions[entity];
    const count = await db.query(`select count(*)::int total,count(*) filter(where active)::int active from ${definition.table}`);
    result[entity] = count.rows[0];
  }
  return result;
}

export async function catalogSuggestions(db) {
  const codes = {};
  await db.query('begin');
  try {
    for (const entity of catalogEntities) codes[entity] = await nextCode(db, definitions[entity]);
    await db.query('rollback');
  } catch (error) { await db.query('rollback').catch(()=>{}); throw error; }
  return { codes };
}

export async function createCatalogRow(db, entity, input, actor = 'dashboard-session') {
  const definition = catalogDefinition(entity), payload = validateCatalogPayload(entity,input);
  await db.query('begin');
  try {
    const code = clean(input.code) || await nextCode(db,definition);
    const codePattern = new RegExp(`^${definition.prefix}\\d{${definition.minDigits},8}$`);
    if (!codePattern.test(code)) throw badRequest(`Mã ${entity} không hợp lệ`);
    if ((await db.query(`select 1 from ${definition.table} where ${definition.code}=$1 limit 1`,[code])).rows[0]) throw conflict(`Mã ${code} đã tồn tại`);
    await assertRelations(db,entity,payload,{});
    const columns=[definition.code,...Object.keys(payload)], values=[code,...Object.values(payload)];
    const params=values.map((_,i)=>`$${i+1}`).join(',');
    const inserted=(await db.query(`insert into ${definition.table}(${columns.join(',')}) values(${params}) returning id,${definition.code} code,*`,values)).rows[0];
    if(entity==='channels') await refreshStaffChannelCounts(db,[inserted.owner_staff_id]);
    const after=rowView(definition,inserted);
    await audit(db,{entity,id:inserted.id,code,action:'create',actor,before:null,after,changedFields:Object.keys(payload)});
    const report=await syncReportAccess(db,entity,{...inserted,code});
    await db.query('commit');
    return { row: inserted, report };
  } catch(error){await db.query('rollback').catch(()=>{});throw error;}
}

export async function updateCatalogRow(db, entity, id, input, actor = 'dashboard-session') {
  const definition=catalogDefinition(entity),payload=validateCatalogPayload(entity,input,{partial:true});
  const expectedVersion=Number(input.expectedVersion);
  if (!Number.isInteger(expectedVersion)||expectedVersion<1) throw badRequest('Thiếu phiên bản dữ liệu để chống ghi đè');
  if (!Object.keys(payload).length) throw badRequest('Không có trường thay đổi');
  await db.query('begin');
  try {
    const existing=(await db.query(`select id,${definition.code} code,* from ${definition.table} where id=$1 for update`,[id])).rows[0];
    if(!existing) throw notFound('Không tìm thấy dữ liệu');
    if(Number(existing.change_version)!==expectedVersion) throw conflict('Dữ liệu vừa được người khác cập nhật, vui lòng tải lại');
    await assertRelations(db,entity,payload,existing);
    const before=rowView(definition,existing),entries=Object.entries(payload);
    const changed=entries.filter(([key,value])=>String(existing[key]??'')!==String(value??'')).map(([key])=>key);
    if(!changed.length){await db.query('rollback');return {row:existing,report:{state:'unchanged'}};}
    const values=[]; const sets=[];
    for(const [key,value] of entries){values.push(value);sets.push(`${key}=$${values.length}`);}
    values.push(id,expectedVersion);
    const updated=(await db.query(`update ${definition.table} set ${sets.join(',')},change_version=change_version+1,updated_at=now()
      where id=$${values.length-1} and change_version=$${values.length} returning id,${definition.code} code,*`,values)).rows[0];
    if(!updated) throw conflict('Dữ liệu vừa được cập nhật, vui lòng tải lại');
    if(entity==='channels') await refreshStaffChannelCounts(db,[existing.owner_staff_id,updated.owner_staff_id]);
    const after=rowView(definition,updated);
    const action=changed.includes('active')?(updated.active?'activate':'deactivate'):'update';
    await audit(db,{entity,id:updated.id,code:updated.code,action,actor,before,after,changedFields:changed});
    const report=await syncReportAccess(db,entity,updated);
    await db.query('commit');
    return {row:updated,report};
  }catch(error){await db.query('rollback').catch(()=>{});throw error;}
}

export async function listCatalogAudit(db,{limit=100}={}){
  const safe=Math.min(Math.max(Number(limit)||100,1),500);
  return (await db.query(`select id,entity_type,entity_id,entity_code,action,actor,changed_fields,created_at from admin_catalog_audit order by created_at desc limit $1`,[safe])).rows;
}

export async function getStaffReport(db,id,{from='',to='',limit=300}={}){
  const staff=(await db.query(`select id,nv_id code,name,coalesce(role,raw_row->>2) role,active from staff where id=$1`,[id])).rows[0];
  if(!staff) throw notFound('Không tìm thấy nhân sự');
  const where=[`lower(trim(p.owner_name))=lower(trim($1))`],values=[staff.name];
  if(from){values.push(from);where.push(`p.posted_date>=$${values.length}`);}
  if(to){values.push(to);where.push(`p.posted_date<=$${values.length}`);}
  const filter=where.join(' and '),safeLimit=Math.min(Math.max(Number(limit)||300,1),1000);
  const [overview,posts,channels]=await Promise.all([
    db.query(`select count(*)::int posts,coalesce(sum(realtime_view),0)::bigint view,
      coalesce(sum(realtime_like),0)::bigint likes,coalesce(sum(realtime_comment),0)::bigint comments,
      coalesce(sum(realtime_save),0)::bigint saves,coalesce(sum(realtime_share),0)::bigint shares,
      count(*) filter(where coalesce(viral_label,'')<>'')::int viral,
      coalesce(sum(bonus_amount),0)::bigint bonus,
      case when coalesce(sum(realtime_view),0)>0 then
        (sum(coalesce(realtime_like,0)+coalesce(realtime_comment,0)+coalesce(realtime_save,0)+coalesce(realtime_share,0))::numeric/sum(realtime_view)) else 0 end er,
      min(posted_date) from_date,max(posted_date) to_date from reporting_posts_current p where ${filter}`,values),
    db.query(`select p.posted_date::text posted_date,p.brand_text_raw,p.channel_name,p.post_url,p.realtime_view,p.realtime_like,
      p.realtime_comment,p.realtime_save,p.realtime_share,p.viral_label,p.bonus_amount
      from reporting_posts_current p where ${filter} order by p.posted_date desc nulls last,p.realtime_view desc nulls last limit ${safeLimit}`,values),
    db.query(`select c.channel_code code,c.name,c.username,c.follower,c.active from channels c
      where c.owner_staff_id=$1 or lower(trim(c.owner_name))=lower(trim($2)) order by c.active desc,c.name`,[staff.id,staff.name])
  ]);
  return {staff,overview:overview.rows[0],posts:posts.rows,channels:channels.rows,limit:safeLimit};
}
