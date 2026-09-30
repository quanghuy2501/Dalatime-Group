import fs from 'fs';
import path from 'path';
import { connectDb } from '../src/db/postgres.mjs';
import { encryptReportToken, newRegistryToken, registryKey, upsertRegistryToken } from '../src/report/registry.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rotate = args.includes('--rotate');
const outputFlag = args.indexOf('--output');
const output = outputFlag >= 0 ? args[outputFlag + 1] : null;
if (process.env.NODE_ENV === 'production' && (!apply || process.env.REPORT_REGISTRY_PRODUCTION !== '1')) throw new Error('Production ensure blocked; requires --apply and REPORT_REGISTRY_PRODUCTION=1');
const key = registryKey();
if (apply && !key) throw new Error('REPORT_REGISTRY_ENCRYPTION_KEY is required for activation');
const db = await connectDb();
try {
  const entities = (await db.query(`select 'customer'::text scope,client_code object_code,name from clients where active=true and client_code is not null
    union all
    select 'brand',b.brand_code,b.name from brands b where b.active=true and b.brand_code is not null and not exists (
      select 1 from brands other where other.active=true and other.brand_code<>b.brand_code
        and lower(regexp_replace(trim(other.name),'\\s+',' ','g'))=lower(regexp_replace(trim(b.name),'\\s+',' ','g')))
    order by scope,object_code`)).rows;
  const existing = new Map((await db.query(`select scope,object_code,status from report_link_registry`)).rows.map(row => [`${row.scope}:${row.object_code}`, row]));
  const targets = entities.filter(row => rotate || existing.get(`${row.scope}:${row.object_code}`)?.status !== 'active');
  const activeKeys = new Set(entities.map(row => `${row.scope}:${row.object_code}`));
  const wouldRevoke = [...existing.values()].filter(row => row.status === 'active' && !activeKeys.has(`${row.scope}:${row.object_code}`)).length;
  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', activeEntities: entities.length, wouldCreateOrActivate: targets.length, wouldRevoke, rotate }, null, 2));
    process.exit(0);
  }
  const links = [];
  await db.query('begin');
  await db.query(`update report_link_registry r set status='revoked',revoked_at=now()
    where status='active' and ((scope='customer' and not exists (select 1 from clients c where c.active=true and c.client_code=r.object_code))
      or (scope='brand' and not exists (select 1 from brands b where b.active=true and b.brand_code=r.object_code
        and not exists (select 1 from brands other where other.active=true and other.brand_code<>b.brand_code
          and lower(regexp_replace(trim(other.name),'\\s+',' ','g'))=lower(regexp_replace(trim(b.name),'\\s+',' ','g'))))))`);
  for (const entity of targets) {
    const { token, tokenHash } = newRegistryToken();
    await upsertRegistryToken(db, { scope: entity.scope, code: entity.object_code, tokenHash, encrypted: encryptReportToken(token, key) });
    links.push({ scope: entity.scope, code: entity.object_code, name: entity.name, reportPath: `/report/${token}` });
  }
  await db.query('commit');
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), oneTime: true, links }, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(output, 0o600);
  }
  console.log(JSON.stringify({ mode: 'applied', activeEntities: entities.length, createdOrActivated: links.length, revoked: wouldRevoke, oneTimeOutput: output || null }));
} catch (error) { try { await db.query('rollback'); } catch {} throw error; }
finally { await db.end(); }
