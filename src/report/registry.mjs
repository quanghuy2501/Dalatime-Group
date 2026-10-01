import crypto from 'crypto';
import { hashReportToken, resolveReportPrincipal } from './config.mjs';

export const REPORT_SCOPES = Object.freeze(['customer', 'brand']);
const HASH_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;

export function registryKey(env = process.env) {
  const value = String(env.REPORT_REGISTRY_ENCRYPTION_KEY || '').trim();
  if (!value) return null;
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('REPORT_REGISTRY_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

export function encryptReportToken(token, key) {
  if (!key) throw new Error('Report registry encryption key is unavailable');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return { tokenCiphertext: ciphertext.toString('base64'), tokenIv: iv.toString('base64'), tokenTag: cipher.getAuthTag().toString('base64') };
}

export function decryptReportToken(row, key) {
  if (!key || !row?.token_ciphertext || !row?.token_iv || !row?.token_tag) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.token_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.token_ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function principalFromRegistryRow(row) {
  if (!row || row.status !== 'active' || !REPORT_SCOPES.includes(row.scope)) return null;
  return row.scope === 'brand'
    ? { scope: 'brand', brandCode: row.object_code, source: 'registry' }
    : { scope: 'customer', clientCode: row.object_code, source: 'registry' };
}

export async function resolveRegistryPrincipal(db, token, fallbackEntries = []) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const tokenHash = hashReportToken(token);
  if (!HASH_RE.test(tokenHash)) return null;
  try {
    const match = (await db.query(`select scope,object_code,status from report_link_registry where token_hash=$1 limit 1`, [tokenHash])).rows[0];
    if (match) return principalFromRegistryRow(match);
    const fallback = resolveReportPrincipal(token, fallbackEntries);
    if (!fallback) return null;
    const scope = fallback.scope || 'customer';
    const code = scope === 'brand' ? fallback.brandCode : fallback.clientCode;
    const claimed = (await db.query(`select 1 from report_link_registry where scope=$1 and object_code=$2 limit 1`, [scope, code])).rows[0];
    return claimed ? null : { ...fallback, scope, source: 'config-fallback' };
  } catch (error) {
    // Only a missing migration permits transition fallback. DB/network/SQL errors fail closed.
    if (error?.code === '42P01') return resolveReportPrincipal(token, fallbackEntries);
    throw error;
  }
}

export function newRegistryToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashReportToken(token) };
}

export async function upsertRegistryToken(db, { scope, code, tokenHash, encrypted = null }) {
  if (!REPORT_SCOPES.includes(scope) || !code || !HASH_RE.test(tokenHash)) throw new Error('Invalid registry token input');
  const values = [scope, code, tokenHash, encrypted?.tokenCiphertext || null, encrypted?.tokenIv || null, encrypted?.tokenTag || null];
  return (await db.query(`insert into report_link_registry
    (scope,object_code,token_hash,token_ciphertext,token_iv,token_tag,status,created_at,rotated_at,revoked_at)
    values ($1,$2,$3,$4,$5,$6,'active',now(),null,null)
    on conflict (scope,object_code) do update set
      token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,token_tag=excluded.token_tag,
      status='active',rotated_at=now(),revoked_at=null
    returning scope,object_code,status,created_at,rotated_at`, values)).rows[0];
}

export async function encryptExistingRegistryToken(db, { code, tokenHash, encrypted }) {
  if (!code || !HASH_RE.test(tokenHash) || !encrypted) throw new Error('Invalid existing registry token input');
  return (await db.query(`update report_link_registry set token_ciphertext=$3,token_iv=$4,token_tag=$5
    where scope='customer' and object_code=$1 and token_hash=$2 and status='active'
    returning object_code`, [code, tokenHash, encrypted.tokenCiphertext, encrypted.tokenIv, encrypted.tokenTag])).rows[0] || null;
}

export async function importLegacyRegistryToken(db, { code, tokenHash, encrypted }) {
  if (!code || !HASH_RE.test(tokenHash) || !encrypted) throw new Error('Invalid legacy registry token input');
  return (await db.query(`insert into report_link_registry
    (scope,object_code,token_hash,token_ciphertext,token_iv,token_tag,status,created_at,rotated_at,revoked_at)
    values ('customer',$1,$2,$3,$4,$5,'active',now(),null,null)
    on conflict (scope,object_code) do update set
      token_hash=excluded.token_hash,token_ciphertext=excluded.token_ciphertext,token_iv=excluded.token_iv,token_tag=excluded.token_tag,
      status='active',rotated_at=now(),revoked_at=null
    where report_link_registry.status<>'active'
    returning object_code`, [code, tokenHash, encrypted.tokenCiphertext, encrypted.tokenIv, encrypted.tokenTag])).rows[0] || null;
}
