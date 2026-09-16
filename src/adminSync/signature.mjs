import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-sync-signature';
export const TIMESTAMP_HEADER = 'x-sync-timestamp';

export function signWebhook({ secret, timestamp, body }) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export function verifyWebhookDetailed({ secret, timestamp, body, signature, now = Date.now(), toleranceMs = 5 * 60 * 1000 }) {
  if (!secret) return { ok: false, reason: 'secret_missing' };
  if (body === undefined || body === null || body === '') return { ok: false, reason: 'body_missing' };
  const timestampText = String(timestamp || '');
  if (!/^\d{10,13}$/.test(timestampText)) return { ok: false, reason: 'timestamp_invalid/stale' };
  const milliseconds = timestampText.length === 10 ? Number(timestampText) * 1000 : Number(timestampText);
  if (!Number.isFinite(milliseconds) || Math.abs(now - milliseconds) > toleranceMs) return { ok: false, reason: 'timestamp_invalid/stale' };
  const signatureText = String(signature || '');
  if (!/^[a-f0-9]{64}$/i.test(signatureText)) return { ok: false, reason: 'signature_format' };
  const expected = signWebhook({ secret, timestamp: timestampText, body });
  const matches = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signatureText, 'hex'));
  return matches ? { ok: true, reason: null } : { ok: false, reason: 'signature_mismatch' };
}

export function verifyWebhook(options) {
  return verifyWebhookDetailed(options).ok;
}
