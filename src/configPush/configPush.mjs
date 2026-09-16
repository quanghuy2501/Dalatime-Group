import crypto from 'node:crypto';
import { GoogleApi } from '../google/googleApi.mjs';
import { isRegisteredSourceActive } from '../staffStatus.mjs';

export const CONFIG_RANGE = "'CONFIG'!A1:H20";
export const MARKER_RANGE = "'CONFIG'!X1:Y2";
export const WRITE_ALLOWLIST = Object.freeze([CONFIG_RANGE, MARKER_RANGE]);
const clean = value => String(value ?? '').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const isPushSourceActive = isRegisteredSourceActive;

export function canonicalGrid(values, rows = 20, columns = 8) {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => values?.[row]?.[column] ?? ''));
}

export function snapshotConfig(values, modifiedTime = null) {
  const grid = canonicalGrid(values);
  const hash = crypto.createHash('sha256').update(JSON.stringify(grid)).digest('hex');
  return { values: grid, hash, version: `sha256:${hash.slice(0, 16)}`, modifiedTime };
}

export function assertAllowedRange(range) {
  if (!WRITE_ALLOWLIST.includes(range)) throw new Error(`blocked Google write outside allowlist: ${range}`);
  return range;
}

export function markerValues(snapshot) {
  return [['CONFIG_PUSH_VERSION', snapshot.version], ['CONFIG_PUSH_SHA256', snapshot.hash]];
}

export function markerHash(values) {
  const rows = values || [];
  return rows.find(row => clean(row?.[0]) === 'CONFIG_PUSH_SHA256')?.[1] || null;
}

export async function withAbortTimeout(operation, timeoutMs, scope) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    const error = new Error(`${scope} timed out after ${timeoutMs}ms`);
    controller.abort(error); reject(error);
  }, timeoutMs); });
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]); }
  finally { clearTimeout(timer); }
}

export async function writeAllowedValues(api, spreadsheetId, range, values, { signal } = {}) {
  assertAllowedRange(range);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  return api.fetchJson(url, { method: 'PUT', signal, body: JSON.stringify({ range, majorDimension: 'ROWS', values }) });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; results[index] = await fn(items[index]); }
  }));
  return results;
}

export async function pushTarget({ api, source, snapshot, production = false, timeoutMs = 120000, checkpoint = null, saveCheckpoint = async () => {} }) {
  const started = Date.now();
  const currentConfig = canonicalGrid((await withAbortTimeout(signal => api.values(source.google_file_id, CONFIG_RANGE, { signal }), timeoutMs, `${source.nv_id} CONFIG read`)).values);
  const marker = (await withAbortTimeout(signal => api.values(source.google_file_id, MARKER_RANGE, { signal }), timeoutMs, `${source.nv_id} marker read`)).values || [];
  if (markerHash(marker) === snapshot.hash) return { nvId: source.nv_id, fileId: source.google_file_id, status: 'hash_skip', writes: 0, durationMs: Date.now() - started };
  const configMatches = snapshotConfig(currentConfig).hash === snapshot.hash;
  if (!production) return { nvId: source.nv_id, fileId: source.google_file_id, status: 'dry_run', writes: 0, configMatches, durationMs: Date.now() - started };

  let writes = 0;
  const mayResumeMarker = checkpoint?.snapshot_hash === snapshot.hash && checkpoint?.stage === 'config_written' && configMatches;
  if (!mayResumeMarker) {
    await withAbortTimeout(signal => writeAllowedValues(api, source.google_file_id, CONFIG_RANGE, snapshot.values, { signal }), timeoutMs, `${source.nv_id} CONFIG write`);
    writes += 1;
    await saveCheckpoint({ source, snapshot, stage: 'config_written' });
  }
  await withAbortTimeout(signal => writeAllowedValues(api, source.google_file_id, MARKER_RANGE, markerValues(snapshot), { signal }), timeoutMs, `${source.nv_id} marker write`);
  writes += 1;
  await saveCheckpoint({ source, snapshot, stage: 'complete' });
  return { nvId: source.nv_id, fileId: source.google_file_id, status: mayResumeMarker ? 'resumed' : 'updated', writes, durationMs: Date.now() - started };
}

export async function runConfigPush({ api, sources, snapshot, production = false, concurrency = 2, timeoutMs = 120000, loadCheckpoint = async () => null, saveCheckpoint = async () => {}, onResult = () => {} }) {
  const active = sources.filter(isPushSourceActive);
  const inactive = sources.filter(source => !isPushSourceActive(source));
  const results = await mapLimit(active, Math.max(1, Math.min(2, Number(concurrency) || 2)), async source => {
    try {
      const result = await pushTarget({ api, source, snapshot, production, timeoutMs, checkpoint: await loadCheckpoint(source, snapshot), saveCheckpoint });
      onResult(result); return result;
    } catch (error) {
      const result = { nvId: source.nv_id, fileId: source.google_file_id, status: 'failed', writes: 0, error: String(error.message || error) };
      onResult(result); return result;
    }
  });
  return { production, snapshot: { version: snapshot.version, hash: snapshot.hash, modifiedTime: snapshot.modifiedTime }, total: sources.length, active: active.length, inactive: inactive.length, results,
    counts: Object.fromEntries(['updated','resumed','hash_skip','dry_run','failed'].map(status => [status, results.filter(result => result.status === status).length])) };
}

export async function createConfigPushApi({ production = false } = {}) {
  const rpm = Math.min(55, Math.max(1, Number(process.env.CONFIG_PUSH_REQUESTS_PER_MINUTE || 55)));
  return new GoogleApi({ minDelayMs: Math.ceil(60000 / rpm), maxRetries: Number(process.env.GOOGLE_MAX_RETRIES || 6), scopes: [
    production ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly'
  ] }).init();
}

export { sleep };
