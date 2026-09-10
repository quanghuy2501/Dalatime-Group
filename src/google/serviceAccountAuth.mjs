import fs from 'fs';
import crypto from 'crypto';

export function loadServiceAccount(path = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/Users/quanghuy/.openclaw/secrets/onicorn-dashboard-service-account.json') {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export async function getServiceAccountAccessToken({ scopes, keyPath } = {}) {
  const key = loadServiceAccount(keyPath);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: key.client_email,
    scope: (scopes || ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']).join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claim));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key);
  const jwt = unsigned + '.' + sig.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const json = await res.json();
  if (!res.ok) throw new Error(`Service account token failed: ${JSON.stringify(json)}`);
  return { accessToken: json.access_token, serviceAccountEmail: key.client_email, projectId: key.project_id };
}
