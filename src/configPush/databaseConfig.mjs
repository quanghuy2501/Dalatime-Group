import crypto from 'node:crypto';
import { CONFIG_SECTIONS } from './configPush.mjs';

const hashJson = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const value = input => input === null || input === undefined ? '' : input;
const section = (key, rows) => {
  const contract = CONFIG_SECTIONS.find(item => item.key === key);
  const hash = hashJson(rows);
  return { ...contract, sourceLastRow: null, rows, hash };
};

export async function readDatabaseConfig(db) {
  const [brands,channels,staff,bonus] = await Promise.all([
    db.query(`select b.brand_code,b.name,coalesce(b.group_name,b.raw_row->>2) group_name,
      coalesce(b.client_name,c.name,b.raw_row->>3) client_name,b.client_code,
      case when b.change_version>1 then coalesce(b.start_date::text,'') else coalesce(b.raw_row->>5,b.start_date::text) end start_date,
      case when b.change_version>1 then coalesce(b.end_date::text,'') else coalesce(b.raw_row->>6,b.end_date::text) end end_date,
      coalesce(b.status,b.raw_row->>7) status
      from brands b left join clients c on c.client_code=b.client_code where b.config_visible order by b.config_sort_order nulls last,b.brand_code`),
    db.query(`select c.channel_code,c.name,c.username,c.url,coalesce(s.name,c.owner_name) owner_name
      from channels c left join staff s on s.id=c.owner_staff_id where c.config_visible order by c.config_sort_order nulls last,c.channel_code`),
    db.query(`select s.nv_id,s.name,coalesce(s.role,s.raw_row->>2) role,coalesce(s.phone,s.raw_row->>3) phone,
      coalesce(s.email,s.raw_row->>4) email,
      coalesce(s.channels_count,0) channels_count,
      case when s.change_version>1 then coalesce(s.base_salary::text,'') else coalesce(s.raw_row->>6,s.base_salary::text) end base_salary
      from staff s where s.config_visible order by s.config_sort_order nulls last,s.nv_id`),
    db.query(`select min_snapshot_view,amount_fulltime,amount_parttime from bonus_rules where active_to is null or active_to>=current_date order by min_snapshot_view`)
  ]);
  const sections = [
    section('brand',brands.rows.map(row=>[row.brand_code,row.name,row.group_name,row.client_name,row.client_code,row.start_date,row.end_date,row.status].map(value))),
    section('channel',channels.rows.map(row=>[row.channel_code,row.name,row.username,row.url,row.owner_name].map(value))),
    section('staff',staff.rows.map(row=>[row.nv_id,row.name,row.role,row.phone,row.email,row.channels_count,row.base_salary].map(value))),
    section('bonus',bonus.rows.map(row=>[row.min_snapshot_view,row.amount_fulltime,row.amount_parttime].map(value)))
  ];
  const hash=hashJson(sections.map(({key,rows})=>({key,rows})));
  return {sections,hash,version:`db-sha256:${hash.slice(0,16)}`,modifiedTime:null,authority:'database'};
}
