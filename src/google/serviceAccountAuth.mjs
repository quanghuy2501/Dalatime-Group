import fs from 'fs';
import crypto from 'crypto';

const READONLY_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly'
];

function parseServiceAccountJson(value, source) {
  let key;
  try {
    key = JSON.parse(value);
  } catch {
    throw new Error(`${source} must contain valid service-account JSON`);
  }
  if (!key || typeof key !== 'object' || !key.client_email || !key.private_key) {
    throw new Error(`${source} must contain a service account client_email and private_key`);
  }
  return key;
}

export function loadServiceAccount(path = process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  if (path) {
    try {
      return parseServiceAccountJson(fs.readFileSync(path, 'utf8'), 'GOOGLE_APPLICATION_CREDENTIALS file');
    } catch (error) {
      if (!error?.code) throw error;
    }
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    return parseServiceAccountJson(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, 'GOOGLE_APPLICATION_CREDENTIALS_JSON');
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return parseServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  }
  throw new Error('Google service account credentials unavailable: set GOOGLE_APPLICATION_CREDENTIALS to a readable file or set GOOGLE_APPLICATION_CREDENTIALS_JSON');
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
    scope: (scopes || READONLY_SCOPES).join(' '),
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
