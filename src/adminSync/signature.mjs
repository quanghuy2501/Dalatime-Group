import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-sync-signature';
export const TIMESTAMP_HEADER = 'x-sync-timestamp';

export function signWebhook({ secret, timestamp, body }) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyWebhook({ secret, timestamp, body, signature, now = Date.now(), toleranceMs = 5 * 60 * 1000 }) {
  if (!secret || !/^\d{10,13}$/.test(String(timestamp || '')) || !/^[a-f0-9]{64}$/i.test(String(signature || ''))) return false;
  const milliseconds = String(timestamp).length === 10 ? Number(timestamp) * 1000 : Number(timestamp);
  if (!Number.isFinite(milliseconds) || Math.abs(now - milliseconds) > toleranceMs) return false;
  const expected = signWebhook({ secret, timestamp, body });
  try { return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')); } catch { return false; }
}
